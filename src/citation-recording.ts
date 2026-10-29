import { captureUsage } from "./response/usage/recording.js";
import type { ResponseOverrides } from "./types.js";
import type { FixtureBlock, ResponsesFixtureBlock, CustomToolCall, ToolCall } from "./types.js";

type ObjectValue = Record<string, unknown>;
type TextBlock = Extract<FixtureBlock, { type: "text" }>;
type ToolBlock = Extract<FixtureBlock, { type: "toolCall" }>;
type MetadataKey = "annotations" | "citations";

interface TextState {
  block: TextBlock;
  annotations: Map<number, ObjectValue>;
}

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
}

function objects(value: unknown): ObjectValue[] | undefined {
  return Array.isArray(value) ? value.filter((v) => object(v) !== undefined) : undefined;
}

function argumentsText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

/** Retains text ownership until a cited turn can be represented as ordered fixtures. */
export class CitationRecording {
  private readonly texts = new Map<string, TextState>();
  private readonly tools = new Map<number, ToolBlock>();
  private readonly customs = new Map<
    number,
    Extract<ResponsesFixtureBlock, { type: "customToolCall" }>
  >();
  private readonly positions = new Map<string, [number, number]>();
  private cited = false;
  private usage?: ResponseOverrides["usage"];

  constructor(private readonly provider: "responses" | "anthropic") {}

  private text(output: number, content: number): TextState {
    const key = `${output}:${content}`;
    let state = this.texts.get(key);
    if (!state) {
      state = { block: { type: "text", text: "" }, annotations: new Map() };
      this.texts.set(key, state);
      this.positions.set(key, [output, content]);
    }
    return state;
  }

  private tool(index: number): ToolBlock {
    let block = this.tools.get(index);
    if (!block) {
      block = { type: "toolCall", name: "", arguments: "" };
      this.tools.set(index, block);
    }
    return block;
  }

  private snapshotText(output: number, content: number, part: ObjectValue): void {
    const state = this.text(output, content);
    if (typeof part.text === "string") state.block.text = part.text;
    const key: MetadataKey = this.provider === "responses" ? "annotations" : "citations";
    const metadata = objects(part[key]);
    if (metadata !== undefined) {
      if (metadata.length > 0) this.cited = true;
      state.block[key] = metadata;
      if (key === "annotations") {
        state.annotations.clear();
        metadata.forEach((annotation, index) => state.annotations.set(index, annotation));
      }
    }
  }

  private responseItem(index: number, item: ObjectValue): void {
    if (item.type === "message" && Array.isArray(item.content)) {
      item.content.forEach((raw, contentIndex) => {
        const part = object(raw);
        if (part?.type === "output_text") this.snapshotText(index, contentIndex, part);
      });
    } else if (item.type === "function_call") {
      const block = this.tool(index);
      if (typeof item.name === "string") block.name = item.name;
      if (typeof item.call_id === "string") block.id = item.call_id;
      if (typeof item.arguments === "string") block.arguments = item.arguments;
      if (typeof item.namespace === "string") block.namespace = item.namespace;
    } else if (item.type === "custom_tool_call") {
      this.customs.set(index, {
        type: "customToolCall",
        name: String(item.name ?? ""),
        input: String(item.input ?? ""),
        ...(typeof item.call_id === "string" ? { id: item.call_id } : {}),
        ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}),
      });
    }
  }

  private anthropicBlock(index: number, block: ObjectValue): void {
    if (block.type === "text") {
      this.snapshotText(index, 0, block);
    } else if (block.type === "tool_use") {
      const target = this.tool(index);
      if (typeof block.name === "string") target.name = block.name;
      if (typeof block.id === "string") target.id = block.id;
      if (block.input !== undefined) target.arguments = argumentsText(block.input);
    }
  }

  captureJSON(value: ObjectValue): void {
    if (this.provider === "responses" && Array.isArray(value.output)) {
      this.usage = captureUsage({
        family: "openai",
        stage: "stream",
        observation: value,
        previous: this.usage,
      });
      value.output.forEach((raw, index) => {
        const item = object(raw);
        if (item) this.responseItem(index, item);
      });
    } else if (this.provider === "anthropic" && Array.isArray(value.content)) {
      value.content.forEach((raw, index) => {
        const block = object(raw);
        if (block) this.anthropicBlock(index, block);
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
    if (
      type === "response.custom_tool_call_input.delta" ||
      type === "response.custom_tool_call_input.done"
    ) {
      const block = this.customs.get(output);
      if (block && type.endsWith(".delta") && typeof event.delta === "string")
        block.input += event.delta;
      if (block && type.endsWith(".done") && typeof event.input === "string")
        block.input = event.input;
      return;
    }
    if (type === "response.function_call_arguments.delta") {
      if (typeof event.delta === "string") this.tool(output).arguments += event.delta;
      return;
    }
    if (type === "response.function_call_arguments.done") {
      if (typeof event.arguments === "string") this.tool(output).arguments = event.arguments;
      return;
    }
    if (typeof event.content_index !== "number") return;
    const content = event.content_index;
    if (type === "response.content_part.added" || type === "response.content_part.done") {
      const part = object(event.part);
      if (part?.type === "output_text") this.snapshotText(output, content, part);
    } else if (type === "response.output_text.delta") {
      if (typeof event.delta === "string") this.text(output, content).block.text += event.delta;
    } else if (type === "response.output_text.done") {
      if (typeof event.text === "string") this.text(output, content).block.text = event.text;
    } else if (type === "response.output_text.annotation.added") {
      const annotation = object(event.annotation);
      if (annotation && typeof event.annotation_index === "number") {
        this.cited = true;
        this.text(output, content).annotations.set(event.annotation_index, annotation);
      }
    }
  }

  private anthropicEvent(event: ObjectValue): void {
    if (typeof event.index !== "number") return;
    const index = event.index;
    if (event.type === "content_block_start") {
      const block = object(event.content_block);
      if (block) {
        this.anthropicBlock(index, block);
        // Tool input starts with an empty object; subsequent deltas contain its JSON.
        if (
          block.type === "tool_use" &&
          object(block.input) &&
          Object.keys(block.input as ObjectValue).length === 0
        ) {
          this.tool(index).arguments = "";
        }
      }
      return;
    }
    if (event.type !== "content_block_delta") return;
    const delta = object(event.delta);
    if (!delta) return;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      this.text(index, 0).block.text += delta.text;
    } else if (delta.type === "citations_delta") {
      const citation = object(delta.citation);
      if (citation) {
        this.cited = true;
        const block = this.text(index, 0).block;
        (block.citations ??= []).push(citation);
      }
    } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      this.tool(index).arguments += delta.partial_json;
    }
  }

  result():
    | {
        blocks?: FixtureBlock[];
        responsesBlocks?: ResponsesFixtureBlock[];
        customToolCalls?: CustomToolCall[];
        content: string;
        toolCalls: ToolCall[];
      }
    | undefined {
    const entries: { position: [number, number]; block: ResponsesFixtureBlock }[] = [];
    for (const [key, state] of this.texts) {
      const block = structuredClone(state.block);
      if (this.provider === "responses" && state.annotations.size > 0) {
        block.annotations = [...state.annotations.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, annotation]) => structuredClone(annotation));
      }
      entries.push({ position: this.positions.get(key)!, block });
    }
    if (!this.cited) return undefined;
    for (const [index, tool] of this.tools) {
      entries.push({
        position: [index, -1],
        block: { ...tool, arguments: tool.arguments || "{}" },
      });
    }
    for (const [index, block] of this.customs)
      entries.push({ position: [index, -1], block: { ...block } });
    entries.sort((a, b) => a.position[0] - b.position[0] || a.position[1] - b.position[1]);
    const blocks = entries.map((entry) => entry.block);
    const content = blocks
      .filter((block): block is TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    const toolCalls = blocks
      .filter((block): block is ToolBlock => block.type === "toolCall")
      .map(({ name, arguments: args, id, namespace }) => ({
        name,
        arguments: args,
        ...(id ? { id } : {}),
        ...(namespace !== undefined ? { namespace } : {}),
      }));
    if (this.customs.size)
      return {
        responsesBlocks: blocks,
        ...(this.usage ? { usage: this.usage } : {}),
        content,
        toolCalls,
        customToolCalls: blocks.flatMap((block) =>
          block.type === "customToolCall" ? [{ ...block, type: "custom" as const }] : [],
        ),
      };
    return {
      blocks: blocks as FixtureBlock[],
      content,
      toolCalls,
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
}
