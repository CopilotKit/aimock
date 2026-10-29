import { captureUsage } from "./response/usage/recording.js";
import type { CollapseResult } from "./stream-collapse.js";
import type { FixtureBlock, ResponseOverrides, ResponsesFixtureBlock } from "./types.js";

type ObjectValue = Record<string, unknown>;
type TextBlock = Extract<FixtureBlock, { type: "text" }>;

interface TextState {
  position: [number, number];
  text: string;
  /** Native metadata by its index: `annotation_index` (Responses) or arrival (Anthropic). */
  metadata: Map<number, ObjectValue>;
}

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
}

/**
 * The one test for a cited turn: a text block whose provider-native citation
 * metadata (`annotations` on Responses, `citations` on Anthropic) is a
 * non-empty array. Recording, collapsing and the recorder all decide with it.
 */
export function hasNativeCitations(block: ResponsesFixtureBlock): boolean {
  return (
    block.type === "text" &&
    ((Array.isArray(block.annotations) && block.annotations.length > 0) ||
      (Array.isArray(block.citations) && block.citations.length > 0))
  );
}

/**
 * Reads the provider-native citation metadata of one recorded turn. It owns
 * only text: every tool call in a cited turn comes from the caller's own
 * collapse, so a cited recording is the uncited recording plus citation data.
 */
export class CitationRecording {
  private readonly texts = new Map<string, TextState>();
  private recordedUsage?: ResponseOverrides["usage"];
  /** Anthropic: the index an index-less event belongs to (the last block opened). */
  private lastIndex?: number;
  /** Anthropic: keys for index-less blocks, above any real index (as the collapser keys them). */
  private nextSyntheticIndex = 1_000_000;

  constructor(private readonly provider: "responses" | "anthropic") {}

  /** Sanitized usage of a captured Responses JSON body, ready for a fixture. */
  get usage(): ResponseOverrides["usage"] | undefined {
    return this.recordedUsage;
  }

  private text(output: number, content: number): TextState {
    const key = `${output}:${content}`;
    let state = this.texts.get(key);
    if (!state) {
      state = { position: [output, content], text: "", metadata: new Map() };
      this.texts.set(key, state);
    }
    return state;
  }

  private snapshotText(output: number, content: number, part: ObjectValue): void {
    const state = this.text(output, content);
    if (typeof part.text === "string") state.text = part.text;
    const metadata = part[this.provider === "responses" ? "annotations" : "citations"];
    if (Array.isArray(metadata)) {
      state.metadata.clear();
      metadata.forEach((entry, index) => {
        const value = object(entry);
        if (value) state.metadata.set(index, value);
      });
    }
  }

  private responseItem(index: number, item: ObjectValue): void {
    if (item.type === "message" && Array.isArray(item.content)) {
      item.content.forEach((raw, contentIndex) => {
        const part = object(raw);
        if (part?.type === "output_text") this.snapshotText(index, contentIndex, part);
      });
    }
  }

  captureJSON(value: ObjectValue): void {
    if (this.provider === "responses" && Array.isArray(value.output)) {
      this.recordedUsage = captureUsage({
        family: "final",
        stage: "final",
        observation: value.usage,
      });
      value.output.forEach((raw, index) => {
        const item = object(raw);
        if (item) this.responseItem(index, item);
      });
    } else if (this.provider === "anthropic" && Array.isArray(value.content)) {
      value.content.forEach((raw, index) => {
        const block = object(raw);
        if (block?.type === "text") this.snapshotText(index, 0, block);
      });
    }
  }

  captureEvent(event: ObjectValue): void {
    if (this.provider === "anthropic") {
      this.anthropicEvent(event);
    } else {
      this.responsesEvent(event);
    }
  }

  private responsesEvent(event: ObjectValue): void {
    const type = event.type;
    if (type === "response.completed" || type === "response.incomplete") {
      const response = object(event.response);
      if (response) this.captureJSON(response);
      return;
    }
    if (typeof event.output_index !== "number") return;
    const output = event.output_index;
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = object(event.item);
      if (item) this.responseItem(output, item);
      return;
    }
    if (typeof event.content_index !== "number") return;
    const content = event.content_index;
    if (type === "response.content_part.added" || type === "response.content_part.done") {
      const part = object(event.part);
      if (part?.type === "output_text") this.snapshotText(output, content, part);
    } else if (type === "response.output_text.delta") {
      if (typeof event.delta === "string") this.text(output, content).text += event.delta;
    } else if (type === "response.output_text.done") {
      if (typeof event.text === "string") this.text(output, content).text = event.text;
    } else if (type === "response.output_text.annotation.added") {
      const annotation = object(event.annotation);
      if (annotation && typeof event.annotation_index === "number") {
        this.text(output, content).metadata.set(event.annotation_index, annotation);
      }
    }
  }

  private anthropicEvent(event: ObjectValue): void {
    let index = typeof event.index === "number" ? event.index : undefined;
    if (event.type === "content_block_start") {
      index ??= this.nextSyntheticIndex++;
      this.lastIndex = index;
      const block = object(event.content_block);
      if (block?.type === "text") this.snapshotText(index, 0, block);
      return;
    }
    if (event.type !== "content_block_delta") return;
    index ??= this.lastIndex;
    const delta = object(event.delta);
    if (index === undefined || !delta) return;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      this.text(index, 0).text += delta.text;
    } else if (delta.type === "citations_delta") {
      const citation = object(delta.citation);
      if (citation) {
        const { metadata } = this.text(index, 0);
        metadata.set(Math.max(-1, ...metadata.keys()) + 1, citation);
      }
    }
  }

  /**
   * The cited turn's blocks in provider order (output or content index), or
   * `undefined` when no text block carries citations. `tools` returns the
   * caller's own finalized tool-call blocks, keyed by the same index, so each
   * tool block is exactly the call the uncited recording holds. Empty text
   * without citations is left out, as the uncited recording leaves it out.
   */
  ordered(
    tools: () => ReadonlyMap<number, ResponsesFixtureBlock>,
  ): ResponsesFixtureBlock[] | undefined {
    const key = this.provider === "responses" ? "annotations" : "citations";
    const entries: { position: [number, number]; block: ResponsesFixtureBlock }[] = [];
    for (const state of this.texts.values()) {
      const block: TextBlock = { type: "text", text: state.text };
      if (state.metadata.size > 0) {
        block[key] = [...state.metadata.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, value]) => structuredClone(value));
      }
      if (block.text !== "" || hasNativeCitations(block))
        entries.push({ position: state.position, block });
    }
    if (!entries.some((entry) => hasNativeCitations(entry.block))) return undefined;
    for (const [index, block] of tools()) entries.push({ position: [index, -1], block });
    entries.sort((a, b) => a.position[0] - b.position[0] || a.position[1] - b.position[1]);
    // A Responses message item can hold several output_text parts; later parts
    // of one item are marked so replay rebuilds a single multi-part message.
    if (this.provider === "responses") {
      entries.forEach((entry, i) => {
        const previous = entries[i - 1];
        if (
          entry.block.type === "text" &&
          previous?.block.type === "text" &&
          previous.position[0] === entry.position[0]
        ) {
          entry.block.continuesMessage = true;
        }
      });
    }
    return entries.map((entry) => entry.block);
  }
}

/**
 * A collapse result for a cited turn: `base` (the uncited result) plus the
 * ordered blocks that carry the citations. `blocks` holds the text and
 * function calls; `responsesBlocks` is added only when custom tool calls need
 * it. `content` follows the cited text. Every other field is `base`'s own.
 */
export function withNativeCitations(
  base: CollapseResult,
  ordered: ResponsesFixtureBlock[] | undefined,
): CollapseResult {
  if (!ordered) return base;
  const blocks = ordered.filter((block): block is FixtureBlock => block.type !== "customToolCall");
  const content = blocks
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  return {
    ...base,
    ...(base.content !== undefined || content !== "" ? { content } : {}),
    blocks,
    ...(blocks.length < ordered.length ? { responsesBlocks: ordered } : {}),
  };
}
