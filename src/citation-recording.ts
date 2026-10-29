import type { CollapseResult } from "./stream-collapse.js";
import type { FixtureBlock, ResponsesFixtureBlock } from "./types.js";

type ObjectValue = Record<string, unknown>;
type TextBlock = Extract<FixtureBlock, { type: "text" }>;

/** Text the base collapse appended to its `content`, in arrival order. */
interface Segment {
  key: string;
  length: number;
}

/** A piece of a base text block that belongs to one text part. */
interface Piece {
  key?: string;
  /** Where the piece starts in its part's text. */
  offset: number;
  block: ResponsesFixtureBlock;
}

/** The OpenAI Responses annotation event, and the name openai@4 declares for it. */
const ANNOTATION_EVENTS = new Set([
  "response.output_text.annotation.added",
  "response.output_text_annotation.added",
]);

/** Positional annotation fields, as offsets into the text of their part. */
const OFFSET_FIELDS = ["start_index", "end_index", "index"] as const;

/** The marker that opens a harmony message body. */
const HARMONY_MESSAGE = "<|message|>";

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function count(n: number, one: string, many: string): string {
  return `${n} native citation ${n === 1 ? one : many}`;
}

function splitNote(n: number): string {
  return `${count(n, "annotation", "annotations")} spanning text that the stream split dropped`;
}

function inRange(value: number, length: number): boolean {
  return value >= 0 && value <= length;
}

/** The last item that passes `test`. */
function lastOf<T>(items: T[], test: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return items[i];
  return undefined;
}

/**
 * Whether a Responses `output` item is a message: its `type` is `"message"`,
 * or it names no type at all, as some OpenAI-compatible servers send it. The
 * JSON collapse and the citation recording both decide with it.
 */
export function isResponsesMessage(item: ObjectValue): boolean {
  return typeof item.type !== "string" || item.type === "message";
}

/** A run of harmony-parsed text, and where it sits in the streamed text. */
interface Span {
  /** Where the run starts in the streamed text. */
  raw: number;
  /** Where the run starts in the parsed text. */
  parsed: number;
  length: number;
}

/**
 * Where each run of the harmony-parsed text `parsed` sits in the streamed text
 * `raw`, or `undefined` when `parsed` cannot be laid out over `raw`. The
 * parser joins message bodies: an optional leading text, then each body it
 * routes to the content, which starts right after a `<|message|>` and ends at
 * a control token or at the end. A later body is tried first, so a final
 * answer that repeats an analysis body maps to the answer.
 */
function harmonySpans(raw: string, parsed: string): Span[] | undefined {
  const starts: number[] = raw.startsWith("<|") ? [] : [0];
  for (
    let at = raw.indexOf(HARMONY_MESSAGE);
    at !== -1;
    at = raw.indexOf(HARMONY_MESSAGE, at + 1)
  ) {
    starts.push(at + HARMONY_MESSAGE.length);
  }
  const failed = new Set<string>();
  const layout = (from: number, after: number): Span[] | undefined => {
    if (from === parsed.length) return [];
    const memo = `${from}:${after}`;
    if (failed.has(memo)) return undefined;
    for (let i = starts.length - 1; i >= 0 && starts[i] >= after; i--) {
      const start = starts[i];
      let same = 0;
      while (
        from + same < parsed.length &&
        start + same < raw.length &&
        parsed[from + same] === raw[start + same]
      ) {
        same++;
      }
      for (let length = same; length > 0; length--) {
        const end = start + length;
        if (end !== raw.length && !raw.startsWith("<|", end)) continue;
        const rest = layout(from + length, end);
        if (rest) return [{ raw: start, parsed: from, length }, ...rest];
      }
    }
    failed.add(memo);
    return undefined;
  };
  return layout(0, 0);
}

/** The position in the parsed text of position `at` in the streamed text. */
function parsedAt(spans: Span[], at: number): number | undefined {
  const span = spans.find((s) => at >= s.raw && at <= s.raw + s.length);
  return span && span.parsed + at - span.raw;
}

/** How much of the parsed text comes from the streamed text before `at`. */
function parsedBefore(spans: Span[], at: number): number {
  return spans.reduce((sum, s) => sum + Math.min(Math.max(at - s.raw, 0), s.length), 0);
}

/**
 * The piece, of the pieces of one text, that holds an entry: a point (an
 * `index` only, as a file citation) goes to the last piece that starts before
 * it, so an `index` at a piece's end stays at the end of that piece (the rule
 * replay follows, see `blockAnnotations` in responses.ts); a range goes to the
 * piece its start falls in, or to the last piece when it starts at the end.
 */
function owner<T>(pieces: T[], start: (piece: T) => number, entry: ObjectValue): T {
  const offsets = OFFSET_FIELDS.filter((name) => typeof entry[name] === "number");
  if (offsets.length === 0) return pieces[0];
  const at = Math.min(...offsets.map((name) => entry[name] as number));
  if (offsets.length === 1 && offsets[0] === "index") {
    return lastOf(pieces, (piece) => start(piece) < at) ?? pieces[0];
  }
  return lastOf(pieces, (piece) => start(piece) <= at) ?? pieces[0];
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
 * The provider-native citation metadata of one recorded turn, attached to the
 * collapse that the caller already made of it.
 *
 * It owns no text, no tool calls and no order. The base collapse tells it, at
 * the place it appends text to its `content`, which text part (a Responses
 * `output_index:content_index`, an Anthropic content block) that text belongs
 * to ({@link text}). The citation events only fill each part's metadata.
 * {@link attach} then splits the base result's own text blocks at part
 * boundaries and puts each part's metadata on its pieces. So `content`,
 * `toolCalls`, `reasoning` and the order of the blocks are always the base
 * collapse's, and a cited recording is the uncited recording plus citation
 * data.
 */
export class CitationRecording {
  private readonly segments: Segment[] = [];
  /** Each text part's native metadata, by its index, by part key. */
  private readonly parts = new Map<string, Map<number, ObjectValue>>();
  /**
   * Every part key, in the order it was first seen, with a `tool#` key at the
   * place each tool call arrived (a Responses function or custom call, an
   * Anthropic `tool_use`).
   */
  private readonly seen = new Set<string>();
  /**
   * Responses output indexes, or Anthropic block keys, known to hold something
   * other than text (a tool call, reasoning, a server tool). Metadata addressed
   * to one of them is not text metadata, so it makes no text block.
   */
  private readonly nonText = new Set<string>();
  /**
   * Non-object metadata entries, by part key: the indexes they arrived at, and
   * how many came with no index. A later snapshot of the part, or an object
   * at the same index, takes their place, so they are no longer dropped.
   */
  private readonly dropped = new Map<string, { at: Set<number>; unindexed: number }>();
  /** Responses: the open message item, and each item's open content part. */
  private openOutput?: number;
  private readonly openContent = new Map<number, number>();
  /** Anthropic: the key of the last block opened, and the next minted key. */
  private openBlock?: string;
  private nextBlock = 0;

  constructor(private readonly provider: "responses" | "anthropic") {}

  /**
   * Called by the base collapse each time it appends `length` characters of
   * text to its `content`, with the key of the text part they belong to.
   */
  text(key: string, length: number): void {
    if (length === 0) return;
    this.seen.add(key);
    const last = this.segments[this.segments.length - 1];
    if (last?.key === key) {
      last.length += length;
    } else {
      this.segments.push({ key, length });
    }
  }

  private part(key: string): Map<number, ObjectValue> {
    this.seen.add(key);
    let part = this.parts.get(key);
    if (!part) {
      part = new Map();
      this.parts.set(key, part);
    }
    return part;
  }

  private drops(key: string): { at: Set<number>; unindexed: number } {
    let drops = this.dropped.get(key);
    if (!drops) {
      drops = { at: new Set(), unindexed: 0 };
      this.dropped.set(key, drops);
    }
    return drops;
  }

  /** A part's whole metadata array (a snapshot): it replaces what came before. */
  private snapshot(key: string, metadata: unknown): void {
    if (!Array.isArray(metadata)) return;
    const part = this.part(key);
    part.clear();
    this.dropped.delete(key);
    metadata.forEach((entry, index) => {
      const value = object(entry);
      if (value) part.set(index, value);
      else this.drops(key).at.add(index);
    });
  }

  /** One more metadata entry, at `index` or after the last one. */
  private add(key: string, index: number | undefined, entry: unknown): void {
    const part = this.part(key);
    const value = object(entry);
    if (index === undefined) {
      if (value) part.set(Math.max(-1, ...part.keys()) + 1, value);
      else this.drops(key).unindexed++;
    } else if (value) {
      part.set(index, value);
      this.dropped.get(key)?.at.delete(index);
    } else {
      this.drops(key).at.add(index);
    }
  }

  // -------------------------------------------------------------------------
  // OpenAI Responses
  // -------------------------------------------------------------------------

  /**
   * The text-part key of a Responses event. An event that omits
   * `output_index` or `content_index` belongs to the message item and the
   * content part that opened last (or item -1, part 0 when none did).
   */
  responsesKey(event: ObjectValue): string {
    const output = number(event.output_index) ?? this.openOutput ?? -1;
    const content = number(event.content_index) ?? this.openContent.get(output) ?? 0;
    return `${output}:${content}`;
  }

  private responseItem(output: number, item: ObjectValue): void {
    if (!isResponsesMessage(item)) {
      this.nonText.add(String(output));
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        this.seen.add(`tool#${output}`);
      }
    } else if (Array.isArray(item.content)) {
      item.content.forEach((raw, content) => {
        const part = object(raw);
        if (part?.type === "output_text") this.snapshot(`${output}:${content}`, part.annotations);
      });
    }
  }

  /** The metadata of one Responses stream event. */
  responsesEvent(event: ObjectValue): void {
    const type = event.type;
    if (type === "response.completed" || type === "response.incomplete") {
      const output = object(event.response)?.output;
      if (Array.isArray(output)) {
        output.forEach((raw, index) => {
          const item = object(raw);
          if (item) this.responseItem(index, item);
        });
      }
      return;
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const output = number(event.output_index);
      const item = object(event.item);
      if (output === undefined || !item) return;
      if (type === "response.output_item.added" && isResponsesMessage(item)) {
        this.openOutput = output;
      }
      this.responseItem(output, item);
      return;
    }
    if (type === "response.content_part.added" || type === "response.content_part.done") {
      const part = object(event.part);
      if (part?.type !== "output_text") return;
      const key = this.responsesKey(event);
      const output = number(event.output_index);
      const content = number(event.content_index);
      if (type === "response.content_part.added" && output !== undefined && content !== undefined) {
        this.openContent.set(output, content);
      }
      this.snapshot(key, part.annotations);
      return;
    }
    if (typeof type === "string" && ANNOTATION_EVENTS.has(type)) {
      this.add(this.responsesKey(event), number(event.annotation_index), event.annotation);
    }
  }

  // -------------------------------------------------------------------------
  // Anthropic
  // -------------------------------------------------------------------------

  /**
   * The metadata of one Anthropic stream event, given the event type the base
   * collapse reads it as. Returns the block key of a `content_block_start` or
   * `content_block_delta` (its `index`, or for an index-less event the block
   * that opened last), for the base collapse to pass to {@link text}.
   */
  anthropicEvent(eventType: string, event: ObjectValue): string | undefined {
    if (eventType === "content_block_start") {
      const index = number(event.index);
      const key = index !== undefined ? String(index) : `+${this.nextBlock++}`;
      this.openBlock = key;
      const block = object(event.content_block);
      if (block?.type === "text") {
        this.snapshot(key, block.citations);
      } else if (typeof block?.type === "string") {
        this.nonText.add(key);
        if (block.type === "tool_use") this.seen.add(`tool#${key}`);
      }
      return key;
    }
    if (eventType !== "content_block_delta") return undefined;
    const index = number(event.index);
    const key = index !== undefined ? String(index) : (this.openBlock ?? "lead");
    const delta = object(event.delta);
    if (delta?.type === "citations_delta") this.add(key, undefined, delta.citation);
    return key;
  }

  /**
   * The text and metadata of an Anthropic Messages JSON `content` array, whose
   * text blocks the caller joins into its `content` in this order.
   */
  anthropicJSON(content: unknown[]): void {
    content.forEach((raw, index) => {
      const block = object(raw);
      const key = String(index);
      if (block?.type === "text" && typeof block.text === "string") {
        this.snapshot(key, block.citations);
        this.text(key, block.text.length);
      } else if (typeof block?.type === "string") {
        this.nonText.add(key);
        if (block.type === "tool_use") this.seen.add(`tool#${key}`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Attach
  // -------------------------------------------------------------------------

  private isNonText(key: string): boolean {
    return this.nonText.has(this.provider === "responses" ? key.split(":")[0] : key);
  }

  /** How many non-object entries addressed to a text part are still dropped. */
  private droppedCount(): number {
    let dropped = 0;
    for (const [key, drops] of this.dropped) {
      if (!this.isNonText(key)) dropped += drops.at.size + drops.unindexed;
    }
    return dropped;
  }

  /** Each cited part's metadata, as a sorted copy, by key. */
  private cited(): Map<string, ObjectValue[]> {
    const cited = new Map<string, ObjectValue[]>();
    for (const [key, part] of this.parts) {
      if (part.size === 0 || this.isNonText(key)) continue;
      cited.set(
        key,
        [...part.entries()].sort(([a], [b]) => a - b).map(([, value]) => structuredClone(value)),
      );
    }
    return cited;
  }

  /**
   * `base` plus the citations: its text blocks, split where one text part ends
   * and the next begins, with each part's metadata on its pieces.
   * `content`, `toolCalls` and every other field stay `base`'s own, and the
   * blocks keep `base`'s order. When `base` has no `blocks`, its order is the
   * one it implies: the text, then the function calls, then the custom calls.
   * `harmonyRaw` is the streamed text of a turn whose `content` was
   * harmony-parsed; offsets are then moved into the parsed text, and an
   * annotation that points outside it is dropped and reported.
   */
  attach(base: CollapseResult, harmonyRaw?: string): CollapseResult {
    const notes: string[] = [];
    const dropped = this.droppedCount();
    if (dropped > 0) {
      notes.push(
        `${count(dropped, "entry that is not an object", "entries that are not objects")} dropped`,
      );
    }
    const cited = this.cited();
    let ordered: ResponsesFixtureBlock[] | undefined;
    if (cited.size > 0) {
      ordered =
        harmonyRaw !== undefined
          ? this.harmonyBlocks(base, harmonyRaw, cited, notes)
          : this.splitBlocks(base, cited, notes);
    }
    const citationNote = notes.length > 0 ? { citationNote: notes.join("; ") } : {};
    if (!ordered?.some(hasNativeCitations)) {
      return notes.length > 0 ? { ...base, ...citationNote } : base;
    }
    const blocks = ordered.filter(
      (block): block is FixtureBlock => block.type !== "customToolCall",
    );
    return {
      ...base,
      blocks,
      ...(blocks.length < ordered.length ? { responsesBlocks: ordered } : {}),
      ...citationNote,
    };
  }

  /** The blocks `base` holds, or the order its flat fields imply. */
  private baseBlocks(base: CollapseResult, content: string): ResponsesFixtureBlock[] {
    const customs = (base.customToolCalls ?? []).map(
      (call): ResponsesFixtureBlock => ({
        type: "customToolCall",
        name: call.name,
        input: call.input,
        ...(call.id !== undefined ? { id: call.id } : {}),
        ...(call.namespace !== undefined ? { namespace: call.namespace } : {}),
      }),
    );
    if (base.responsesBlocks) return base.responsesBlocks.map((block) => ({ ...block }));
    if (base.blocks) return [...base.blocks.map((block) => ({ ...block })), ...customs];
    return [
      ...(content !== "" ? [{ type: "text" as const, text: content }] : []),
      ...(base.toolCalls ?? []).map((tc): ResponsesFixtureBlock => ({ type: "toolCall", ...tc })),
      ...customs,
    ];
  }

  /**
   * `base`'s blocks with each text block cut into pieces, one per text part,
   * and each cited part's metadata placed on its pieces.
   */
  private splitBlocks(
    base: CollapseResult,
    cited: Map<string, ObjectValue[]>,
    notes: string[],
  ): ResponsesFixtureBlock[] {
    const pieces: Piece[] = [];
    const length = new Map<string, number>();
    let segment = 0;
    let used = 0;
    for (const block of this.baseBlocks(base, base.content ?? "")) {
      if (block.type !== "text") {
        pieces.push({ offset: 0, block });
        continue;
      }
      let at = 0;
      while (at < block.text.length) {
        const current = this.segments[segment];
        const take = current
          ? Math.min(current.length - used, block.text.length - at)
          : block.text.length - at;
        const offset = current ? (length.get(current.key) ?? 0) : 0;
        if (current) length.set(current.key, offset + take);
        pieces.push({
          key: current?.key,
          offset,
          block: { type: "text", text: block.text.slice(at, at + take) },
        });
        at += take;
        used += take;
        if (current && used === current.length) {
          segment++;
          used = 0;
        }
      }
    }
    this.placeEmptyParts(
      pieces,
      cited,
      base.blocks !== undefined || base.responsesBlocks !== undefined,
    );
    let outside = 0;
    let split = 0;
    for (const [key, metadata] of cited) {
      const lost = this.placeMetadata(
        pieces.filter((piece) => piece.key === key),
        metadata,
      );
      outside += lost.outside;
      split += lost.split;
    }
    if (outside > 0) {
      notes.push(
        `${count(outside, "annotation pointing outside its text", "annotations pointing outside their text")} dropped`,
      );
    }
    if (split > 0) notes.push(splitNote(split));
    if (this.provider === "responses") {
      // A later part of one Responses message item serves as a further part
      // of that message.
      pieces.forEach((piece, i) => {
        const previous = pieces[i - 1];
        if (
          piece.block.type === "text" &&
          piece.key !== undefined &&
          previous?.block.type === "text" &&
          previous.key !== undefined &&
          previous.key !== piece.key &&
          previous.key.split(":")[0] === piece.key.split(":")[0]
        ) {
          piece.block.continuesMessage = true;
        }
      });
    }
    return pieces.map((piece) => piece.block);
  }

  /**
   * A cited part that streamed no text becomes an empty text block, in the
   * place it arrived: right after what arrived just before it (the last piece
   * of a text part, or the block of a tool call), or first when nothing did.
   * Tool calls are matched to `base`'s tool blocks in arrival order. When
   * `base` has no blocks of its own (`ordered` is false), its text comes
   * before its tool calls, so the part is placed among the text only.
   */
  private placeEmptyParts(
    pieces: Piece[],
    cited: Map<string, ObjectValue[]>,
    ordered: boolean,
  ): void {
    const placed = new Set(pieces.flatMap((piece) => (piece.key ? [piece.key] : [])));
    const tools = ordered
      ? pieces.filter(
          (piece) => piece.block.type === "toolCall" || piece.block.type === "customToolCall",
        )
      : [];
    let tool = 0;
    let previous: Piece | undefined;
    for (const key of this.seen) {
      if (key.startsWith("tool#")) {
        previous = tools[tool++] ?? previous;
      } else if (!placed.has(key) && cited.has(key)) {
        const piece: Piece = { key, offset: 0, block: { type: "text", text: "" } };
        pieces.splice(previous ? pieces.indexOf(previous) + 1 : 0, 0, piece);
        placed.add(key);
        previous = piece;
      } else if (placed.has(key)) {
        previous = lastOf(pieces, (piece) => piece.key === key);
      }
    }
  }

  /**
   * Puts one part's metadata on its pieces, and returns how many entries it
   * dropped. An entry with an offset outside the part's text is dropped
   * (`outside`); a part that streamed no text keeps every entry as the
   * provider sent it. When the stream split the part, an entry with offsets
   * goes on the piece that holds it (see {@link owner}), with its offsets made
   * relative to that piece, and one that ends past that piece is dropped
   * (`split`). An entry without offsets goes on the first piece.
   */
  private placeMetadata(
    pieces: Piece[],
    metadata: ObjectValue[],
  ): { outside: number; split: number } {
    const field = this.provider === "responses" ? "annotations" : "citations";
    const textOf = (piece: Piece) => (piece.block as TextBlock).text;
    const total = pieces.reduce((sum, piece) => sum + textOf(piece).length, 0);
    if (total === 0) {
      (pieces[0].block as TextBlock)[field] = metadata;
      return { outside: 0, split: 0 };
    }
    const into = new Map<Piece, ObjectValue[]>();
    let outside = 0;
    let split = 0;
    for (const entry of metadata) {
      const offsets = OFFSET_FIELDS.filter((name) => typeof entry[name] === "number");
      if (offsets.some((name) => !inRange(entry[name] as number, total))) {
        outside++;
        continue;
      }
      const piece = owner(pieces, (p) => p.offset, entry);
      const moved = { ...entry };
      const fits = offsets.every((name) => {
        moved[name] = (entry[name] as number) - piece.offset;
        return inRange(moved[name] as number, textOf(piece).length);
      });
      if (!fits) {
        split++;
        continue;
      }
      into.set(piece, [...(into.get(piece) ?? []), moved]);
    }
    for (const [piece, entries] of into) (piece.block as TextBlock)[field] = entries;
    return { outside, split };
  }

  /**
   * The blocks of a harmony-parsed turn. Each text block of `base` that holds
   * streamed text is replaced by the parsed text that came from it (and left
   * out when none did); when `base`'s text is already the parsed text, it is
   * one text block. The harmony tool calls follow. Offsets count from the
   * start of their own part of the streamed text, so each is moved to the
   * streamed text, then into the parsed text, then into its text block.
   */
  private harmonyBlocks(
    base: CollapseResult,
    raw: string,
    cited: Map<string, ObjectValue[]>,
    notes: string[],
  ): ResponsesFixtureBlock[] {
    const content = base.content ?? "";
    const spans = harmonySpans(raw, content);
    // Where each part's text sits in the streamed text, run by run.
    const runs = new Map<string, { raw: number; offset: number; length: number }[]>();
    let at = 0;
    for (const segment of this.segments) {
      const list = runs.get(segment.key) ?? [];
      const last = list[list.length - 1];
      list.push({ raw: at, offset: last ? last.offset + last.length : 0, length: segment.length });
      runs.set(segment.key, list);
      at += segment.length;
    }
    // A start counts from the character it points at; an end or a point from
    // the one before it.
    const streamedAt = (key: string, value: number, start: boolean): number | undefined => {
      const list = runs.get(key) ?? [];
      const inside = (run: { offset: number; length: number }) =>
        value >= run.offset && value <= run.offset + run.length;
      const run =
        list.find((r) => inside(r) && (start ? value < r.offset + r.length : value > r.offset)) ??
        list.find(inside);
      return run && run.raw + value - run.offset;
    };
    const mapped: ObjectValue[] = [];
    let unplaced = 0;
    let outside = 0;
    const keys = [...runs.keys(), ...[...cited.keys()].filter((key) => !runs.has(key))];
    for (const key of keys) {
      for (const annotation of cited.get(key) ?? []) {
        const offsets = OFFSET_FIELDS.filter((name) => typeof annotation[name] === "number");
        if (offsets.length > 0 && !spans) {
          unplaced++;
          continue;
        }
        const moved = { ...annotation };
        const fits = offsets.every((name) => {
          const streamed = streamedAt(key, annotation[name] as number, name === "start_index");
          const parsed = streamed === undefined ? undefined : parsedAt(spans!, streamed);
          moved[name] = parsed;
          return parsed !== undefined;
        });
        if (fits) mapped.push(moved);
        else outside++;
      }
    }
    if (unplaced > 0) {
      notes.push(
        `${count(unplaced, "annotation", "annotations")} dropped: the harmony-parsed text was not found in the streamed text`,
      );
    }
    if (outside > 0) {
      notes.push(
        `${count(outside, "annotation", "annotations")} pointing outside the harmony-parsed text dropped`,
      );
    }
    // Each text block, as the parsed text it holds and where that starts.
    const blocks = this.baseBlocks(base, content);
    const streamedBlocks =
      spans !== undefined &&
      blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") === raw;
    const out: { block: ResponsesFixtureBlock; start?: number }[] = [];
    let cursor = 0;
    for (const block of blocks) {
      if (block.type !== "text") {
        out.push({ block });
      } else if (streamedBlocks) {
        const from = parsedBefore(spans, cursor);
        cursor += block.text.length;
        const to = parsedBefore(spans, cursor);
        if (to > from)
          out.push({ block: { type: "text", text: content.slice(from, to) }, start: from });
      } else if (!out.some((piece) => piece.start !== undefined)) {
        out.push({ block: { type: "text", text: content }, start: 0 });
      }
    }
    if (!out.some((piece) => piece.start !== undefined)) {
      out.unshift({ block: { type: "text", text: content }, start: 0 });
    }
    const texts = out.filter(
      (piece): piece is { block: TextBlock; start: number } => piece.start !== undefined,
    );
    let split = 0;
    for (const annotation of mapped) {
      const piece = owner(texts, (p) => p.start, annotation);
      const moved = { ...annotation };
      const fits = OFFSET_FIELDS.every((name) => {
        if (typeof annotation[name] !== "number") return true;
        moved[name] = (annotation[name] as number) - piece.start;
        return inRange(moved[name] as number, piece.block.text.length);
      });
      if (fits) (piece.block.annotations ??= []).push(moved);
      else split++;
    }
    if (split > 0) notes.push(splitNote(split));
    return out.map((piece) => piece.block);
  }
}
