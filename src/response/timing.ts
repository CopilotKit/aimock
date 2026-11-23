import type {
  Fixture,
  FixtureResponse,
  FixtureToolCall,
  RecordedTimings,
  ToolCall,
} from "../types.js";
import type { MisbehaviorCandidate } from "../misbehavior.js";
import { calculateTotalDelay } from "../sse-writer.js";
import {
  isCombinedFixtureResponse,
  isTextResponse,
  isToolCallResponse,
  resolveFixtureBlockOutcome,
  resolveServedBlockOutcome,
  servedToolCalls,
} from "../helpers.js";

/** Which non-streaming surface asks: OpenAI Chat Completions, or any other provider. */
export type NonStreamingSurface = "openai-chat" | "other";

/**
 * Whether a non-streaming (`stream: false`) reply on `surface` waits. It is
 * opt-in per fixture: `nonStreamingTimingAllProviders: true` on every
 * surface that calls this, or the shipped `nonStreamingTiming: true` on OpenAI Chat
 * Completions only. Either one also needs an explicit `streamingProfile` or
 * `recordedTimings`. Only the boolean `true` counts.
 */
export function nonStreamingTimingEnabled(fixture: Fixture, surface: NonStreamingSurface): boolean {
  const optedIn =
    fixture.nonStreamingTimingAllProviders === true ||
    (fixture.nonStreamingTiming === true && surface === "openai-chat");
  return optedIn && !!(fixture.streamingProfile || fixture.recordedTimings);
}

/**
 * The recorded timings a non-streaming wait on `surface` is sized from. `t` is
 * returned as given when it is `undefined`, when its `interChunkDelaysMs` is
 * an array, or for `nonStreamingTiming: true` on OpenAI Chat Completions.
 * Otherwise (a fixture built in code can omit `interChunkDelaysMs`) it is
 * returned with `interChunkDelaysMs: []`, so the wait counts no recorded gaps
 * and the reply is still served.
 *
 * The `nonStreamingTiming: true` OpenAI Chat Completions case is passed
 * through unchanged so that the shipped option keeps its behavior: with no
 * `streamingProfile`, sizing the wait for a reply of more than one chunk reads
 * the missing `interChunkDelaysMs` and throws. With `deliverJson`'s
 * `duplicateId` set, that path throws on a missing `interChunkDelaysMs` in any
 * case, because {@link extendRecordedTimings} reads the list first.
 */
export function nonStreamingRecordedTimings(
  fixture: Fixture,
  surface: NonStreamingSurface,
  t: RecordedTimings | undefined,
): RecordedTimings | undefined {
  if (!t || Array.isArray(t.interChunkDelaysMs)) return t;
  if (fixture.nonStreamingTiming === true && surface === "openai-chat") return t;
  return { ...t, interChunkDelaysMs: [] };
}

/**
 * The total wait before a non-streaming reply: `calculateTotalDelay` over the
 * content chunks `payloadLength` makes at `chunkSize`. There is no latency
 * input, so bare `latency` never delays a non-streaming reply.
 */
export function nonStreamingDelayMs(
  fixture: Fixture,
  payloadLength: number,
  chunkSize: number,
  recordedTimings: RecordedTimings | undefined,
  replaySpeed: number | undefined,
): number {
  return calculateTotalDelay(
    payloadLength,
    chunkSize,
    fixture.streamingProfile,
    recordedTimings,
    replaySpeed,
  );
}

function toolCallsLength(calls: ToolCall[]): number {
  return calls.map((tc) => tc.name + tc.arguments).join("").length;
}

/**
 * The payload a reply serves, as OpenAI Chat Completions sizes its
 * non-streaming wait: reasoning, then text content, then each tool call's
 * name and arguments. Non-empty `blocks` are authoritative and resolve
 * through `resolveFixtureBlockOutcome`. The inputs are fixture-level values,
 * so the length is the same on every provider.
 */
export function servedPayloadLength(response: FixtureResponse, reasoning?: string): number {
  const reasoningLength = reasoning?.length ?? 0;
  if (isCombinedFixtureResponse(response)) {
    if (response.blocks && response.blocks.length > 0) {
      const outcome = resolveFixtureBlockOutcome(response.blocks);
      return reasoningLength + outcome.content.length + toolCallsLength(outcome.toolCalls);
    }
    return (
      reasoningLength + (response.content ?? "").length + toolCallsLength(response.toolCalls ?? [])
    );
  }
  if (isTextResponse(response)) return reasoningLength + response.content.length;
  if (isToolCallResponse(response)) return reasoningLength + toolCallsLength(response.toolCalls);
  return reasoningLength;
}

/** Each served call's name plus its function `arguments` or custom `input`. */
function servedCallsLength(calls: readonly FixtureToolCall[]): number {
  return calls.map((tc) => tc.name + (tc.type === "custom" ? tc.input : tc.arguments)).join("")
    .length;
}

/**
 * The payload the OpenAI Responses API serves, sized as
 * {@link servedPayloadLength} sizes it but from the Responses carriers: a
 * non-empty `responsesBlocks` (else a non-empty `blocks`) through
 * `resolveServedBlockOutcome`, and `toolCalls` plus `customToolCalls` through
 * `servedToolCalls`. A custom call counts its name and `input`; its stream
 * sends the input in `chunkSize` deltas, as a function call's arguments.
 */
export function responsesPayloadLength(response: FixtureResponse, reasoning?: string): number {
  const reasoningLength = reasoning?.length ?? 0;
  if (isCombinedFixtureResponse(response)) {
    const outcome = resolveServedBlockOutcome(response);
    if (outcome) {
      return reasoningLength + outcome.content.length + servedCallsLength(outcome.toolCalls);
    }
    return (
      reasoningLength +
      (response.content ?? "").length +
      servedCallsLength(servedToolCalls(response))
    );
  }
  if (isTextResponse(response)) return reasoningLength + response.content.length;
  if (isToolCallResponse(response)) {
    return reasoningLength + servedCallsLength(servedToolCalls(response));
  }
  return reasoningLength;
}

/**
 * The stream frames of one `image_generation_call` item: `output_item.added`,
 * the `in_progress`, `generating` and `completed` events, and
 * `output_item.done`.
 */
export const IMAGE_GENERATION_FRAMES = 5;

/**
 * The frames the OpenAI Responses stream sends for a fixture's `citations`
 * and generated `files`, which carry no text for {@link responsesPayloadLength}
 * to count: one `output_text.annotation.added` per citation on a turn with
 * text, and {@link IMAGE_GENERATION_FRAMES} per file (its
 * `image_generation_call` item has no deltas; these frames are its whole
 * stream). The non-streaming wait counts each as one chunk, as the stream
 * counts each as one frame, so the JSON wait is not undersized for them. A
 * malformed value counts as none: this never throws, and the builder rejects
 * it with its coded error before any byte is written.
 */
export function responsesOutputFrames(response: FixtureResponse): number {
  const textTurn = isCombinedFixtureResponse(response) || isTextResponse(response);
  if (!textTurn && !isToolCallResponse(response)) return 0;
  const files = Array.isArray(response.files) ? response.files.length * IMAGE_GENERATION_FRAMES : 0;
  // A tool-only turn has no text to annotate: its builder rejects citations.
  const citations = textTurn && Array.isArray(response.citations) ? response.citations.length : 0;
  return files + citations;
}

/**
 * The payload length for a misbehavior-applied reply. For the three fault
 * terminals on a text response (refusal, content filter, reasoning-only) it is
 * OpenAI's selection: the refusal text, nothing, or the reasoning. In every
 * other case, including a stop plan on a tool-call, combined or blocks
 * response, it is `servedLength`: {@link servedPayloadLength} by default, or
 * {@link responsesPayloadLength} on the OpenAI Responses API.
 */
export function misbehaviorPayloadLength(
  plan: Pick<MisbehaviorCandidate, "response" | "stop" | "refusal" | "reasoning">,
  effReasoning: string | undefined,
  servedLength: (response: FixtureResponse, reasoning?: string) => number = servedPayloadLength,
): number {
  if (
    isTextResponse(plan.response) &&
    (plan.stop === "refusal" || plan.stop === "content_filter" || plan.reasoning !== undefined)
  ) {
    if (plan.stop === "refusal") return (plan.refusal ?? "").length;
    if (plan.stop === "content_filter") return 0;
    return (plan.reasoning ?? "").length;
  }
  return servedLength(plan.response, effReasoning);
}

/**
 * The K4 duplicate-id gap extension: a duplicate-id plan can add frames, so
 * with `duplicate` true the recorded gaps grow to at least `frameCount - 1`
 * entries by repeating the last gap (0 when the list is empty). A longer
 * list is kept whole, except when `frameCount` is `NaN` (a `NaN` chunk size):
 * the list is then truncated to empty. The wait is 0 either way, because a
 * `NaN` chunk size gives no chunks to wait for. With `duplicate` false or no
 * `t`, `t` is returned unchanged.
 */
export function extendRecordedTimings(
  t: RecordedTimings | undefined,
  frameCount: number,
  duplicate: boolean,
): RecordedTimings | undefined {
  if (!duplicate || !t) return t;
  const gaps = t.interChunkDelaysMs;
  return {
    ...t,
    interChunkDelaysMs: Array.from(
      { length: Math.max(gaps.length, frameCount - 1) },
      (_, index) => gaps[index] ?? gaps.at(-1) ?? 0,
    ),
  };
}
