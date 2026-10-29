import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMock } from "../llmock.js";
import { LLMock as MisbehaviorLLMock } from "./helpers/misbehavior-enabled.js";
import { proxyAndRecord } from "../recorder.js";
import { loadFixtureFile, loadFixturesFromDir, validateFixtures } from "../fixture-loader.js";
import {
  collapseOpenAISSE,
  collapseAnthropicSSE,
  collapseStreamingResponse,
} from "../stream-collapse.js";
import { Logger } from "../logger.js";
import type { FixtureFileEntry, FixtureResponse } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Inspect open-ended provider event unions at the wire boundary.
type Json = Record<string, any>;
type Provider = "responses" | "anthropic";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  // Run every cleanup even when one fails, then report all failures.
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "citation-replay cleanup failed");
});
const urlCitation = {
  type: "url_citation",
  url: "https://example.test/source",
  title: "Source",
  start_index: 0,
  end_index: 4,
};
const documentCitation = {
  type: "char_location",
  file_id: null,
  document_index: 0,
  document_title: null,
  cited_text: "fact",
  start_char_index: 0,
  end_char_index: 4,
};
const key = (provider: Provider) => (provider === "responses" ? "annotations" : "citations");
const cite = (provider: Provider) =>
  structuredClone(provider === "responses" ? urlCitation : documentCitation);
function searchAndPathCitations(provider: Provider): Json[] {
  return provider === "responses"
    ? [{ type: "file_path", file_id: "file_path_result", index: 1 }]
    : [
        {
          type: "web_search_result_location",
          url: "https://example.test/web",
          title: null,
          cited_text: "fact",
          encrypted_index: "opaque-search-index",
        },
        {
          type: "search_result_location",
          source: "https://example.test/search",
          title: "Search",
          cited_text: "fact",
          search_result_index: 2,
          start_block_index: 1,
          end_block_index: 2,
        },
      ];
}
const text = (provider: Provider, value: string, metadata: Json[] = [cite(provider)]): Json => ({
  type: "text",
  text: value,
  [key(provider)]: metadata,
});
const tool = {
  type: "toolCall",
  name: "lookup",
  arguments: '{"query":"source"}',
  id: "call_reference",
};
function sse(events: Json[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
function events(body: string): Json[] {
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
    .map((line) => JSON.parse(line.slice(5)));
}
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "citation-replay-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function mock(response?: Json, extended = false): Promise<LLMock> {
  const server = new LLMock({
    port: 0,
    latency: 0,
    chunkSize: 2,
    ...(extended ? { responsesTools: "extended" as const } : {}),
  });
  if (response)
    server.addFixture({
      match: { userMessage: "cited answer" },
      response: response as FixtureResponse,
    });
  await server.start();
  cleanups.push(() => server.stop());
  return server;
}
async function request(
  server: LLMock,
  provider: Provider,
  stream: boolean,
  prompt = "cited answer",
): Promise<{ body: Json; events: Json[] }> {
  const response = await fetch(
    `${server.url}/v1/${provider === "responses" ? "responses" : "messages"}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "local",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(
        provider === "responses"
          ? { model: "gpt-4o", input: prompt, stream }
          : {
              model: "claude-sonnet-4-6",
              max_tokens: 1024,
              messages: [{ role: "user", content: prompt }],
              stream,
            },
      ),
    },
  );
  const raw = await response.text();
  expect(response.status, raw).toBe(200);
  if (!stream) return { body: JSON.parse(raw), events: [] };
  const streamEvents = events(raw);
  if (provider === "responses") {
    const completed = streamEvents.find((event) => event.type === "response.completed");
    expect(completed).toBeDefined();
    const final = completed!.response;
    const streamed = new Map<string, { text: string; annotations: Json[] }>();
    for (const event of streamEvents) {
      const address = `${event.output_index}:${event.content_index}`;
      if (event.type === "response.content_part.added" && event.part.type === "output_text")
        streamed.set(address, { text: event.part.text ?? "", annotations: [] });
      if (event.type === "response.output_text.delta") {
        expect(streamed.has(address)).toBe(true);
        streamed.get(address)!.text += event.delta;
      }
      if (event.type === "response.output_text.annotation.added") {
        const item = final.output[event.output_index];
        expect(item.id).toBe(event.item_id);
        expect(item.content[event.content_index].annotations[event.annotation_index]).toEqual(
          event.annotation,
        );
        expect(streamed.has(address)).toBe(true);
        streamed.get(address)!.annotations.push(event);
      }
    }
    final.output.forEach((item: Json, output: number) => {
      if (item.type !== "message") return;
      item.content.forEach((part: Json, content: number) => {
        if (part.type !== "output_text") return;
        const observed = streamed.get(`${output}:${content}`);
        expect(observed).toBeDefined();
        expect(observed!.text).toBe(part.text);
        const annotations = observed!.annotations.sort(
          (a, b) => a.annotation_index - b.annotation_index,
        );
        expect(annotations.map((event) => event.annotation_index)).toEqual(
          (part.annotations ?? []).map((_: Json, index: number) => index),
        );
        expect(annotations.map((event) => event.annotation)).toEqual(part.annotations ?? []);
      });
    });
    return { body: final, events: streamEvents };
  }
  const blocks = new Map<number, Json>();
  for (const event of streamEvents) {
    if (event.type === "content_block_start")
      blocks.set(event.index, structuredClone(event.content_block));
    if (event.type === "content_block_delta") {
      const block = blocks.get(event.index)!;
      expect(block).toBeDefined();
      if (event.delta.type === "text_delta") block.text += event.delta.text;
      if (event.delta.type === "thinking_delta") block.thinking += event.delta.thinking;
      if (event.delta.type === "signature_delta") block.signature += event.delta.signature;
      if (event.delta.type === "citations_delta")
        (block.citations ??= []).push(event.delta.citation);
      if (event.delta.type === "input_json_delta")
        block.args = (block.args ?? "") + event.delta.partial_json;
    }
  }
  return { body: { content: [...blocks.values()] }, events: streamEvents };
}
function visible(body: Json, provider: Provider): Json[] {
  if (provider === "responses")
    return body.output.flatMap((item: Json) =>
      item.type === "message"
        ? item.content
            .filter((part: Json) => part.type === "output_text")
            .map((part: Json) => ({
              type: "text",
              text: part.text,
              annotations: part.annotations ?? [],
            }))
        : item.type === "function_call"
          ? [
              {
                type: "toolCall",
                name: item.name,
                arguments: JSON.parse(item.arguments),
                id: item.call_id,
              },
            ]
          : [],
    );
  return body.content.flatMap((block: Json) =>
    block.type === "text"
      ? [{ type: "text", text: block.text, citations: block.citations ?? [] }]
      : block.type === "tool_use"
        ? [
            {
              type: "toolCall",
              name: block.name,
              arguments: block.args ? JSON.parse(block.args) : block.input,
              id: block.id,
            },
          ]
        : [],
  );
}
function expected(blocks: Json[], provider: Provider): Json[] {
  return blocks.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text, [key(provider)]: block[key(provider)] ?? [] }
      : {
          ...block,
          arguments:
            typeof block.arguments === "string" ? JSON.parse(block.arguments) : block.arguments,
        },
  );
}
async function assertReplay(
  response: Json,
  blocks: Json[],
  provider: Provider,
  stream = false,
): Promise<void> {
  const server = await mock(response);
  const result = await request(server, provider, stream);
  expect(visible(result.body, provider)).toEqual(expected(blocks, provider));
}
async function replayCollapsed(provider: Provider, input: Json[], blocks: Json[]): Promise<void> {
  const collapsed =
    provider === "responses" ? collapseOpenAISSE(sse(input)) : collapseAnthropicSSE(sse(input));
  await assertReplay(collapsed, blocks, provider);
}
function nativeJSON(provider: Provider, blocks: Json[]): Json {
  if (provider === "responses")
    return {
      output: blocks.map((block) =>
        block.type === "text"
          ? {
              type: "message",
              role: "assistant",
              content: [
                { type: "output_text", text: block.text, annotations: block.annotations ?? [] },
              ],
            }
          : {
              type: "function_call",
              name: block.name,
              arguments: block.arguments,
              call_id: block.id,
            },
      ),
    };
  return {
    content: blocks.map((block) =>
      block.type === "text"
        ? block
        : { type: "tool_use", name: block.name, input: JSON.parse(block.arguments), id: block.id },
    ),
  };
}
function nativeEvents(provider: Provider, blocks: Json[]): Json[] {
  const result: Json[] = [];
  blocks.forEach((block, index) => {
    if (provider === "responses") {
      if (block.type === "toolCall") {
        result.push({
          type: "response.output_item.done",
          output_index: index,
          item: {
            type: "function_call",
            name: block.name,
            arguments: block.arguments,
            call_id: block.id,
          },
        });
      } else {
        result.push({
          type: "response.content_part.added",
          output_index: index,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
        result.push({
          type: "response.output_text.delta",
          output_index: index,
          content_index: 0,
          delta: block.text,
        });
        (block.annotations ?? []).forEach((annotation: Json, annotation_index: number) =>
          result.push({
            type: "response.output_text.annotation.added",
            output_index: index,
            content_index: 0,
            annotation_index,
            annotation,
          }),
        );
      }
    } else if (block.type === "toolCall") {
      result.push({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", name: block.name, id: block.id, input: {} },
      });
      result.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: block.arguments },
      });
    } else {
      result.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      result.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      });
      (block.citations ?? []).forEach((citation: Json) =>
        result.push({
          type: "content_block_delta",
          index,
          delta: { type: "citations_delta", citation },
        }),
      );
    }
    if (provider === "anthropic") result.push({ type: "content_block_stop", index });
  });
  result.push(
    provider === "responses"
      ? { type: "response.completed", response: nativeJSON(provider, blocks) }
      : { type: "message_stop" },
  );
  return result;
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function recorded(
  provider: Provider,
  wire: Json | Json[],
  stream: boolean,
  extended = false,
  logger = new Logger("silent"),
): Promise<LLMock> {
  const dir = directory();
  const upstream = await listen(
    createServer((_req, res) => {
      res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
      res.end(stream ? sse(wire as Json[]) : JSON.stringify(wire));
    }),
  );
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const proxy = await listen(
    createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const request = {
          model: provider === "responses" ? "gpt-4o" : "claude-sonnet-4-6",
          messages: [{ role: "user" as const, content: "cited answer" }],
          stream,
        };
        void proxyAndRecord(
          req,
          res,
          request,
          provider === "responses" ? "openai" : "anthropic",
          `/v1/${provider === "responses" ? "responses" : "messages"}`,
          [],
          {
            record: {
              providers: { [provider === "responses" ? "openai" : "anthropic"]: upstream },
              fixturePath: dir,
            },
            logger,
            ...(extended ? { responsesTools: "extended" as const } : {}),
          },
          raw,
        ).then(resolveDone, (error: unknown) => {
          rejectDone(error);
          res.destroy();
        });
      });
    }),
  );
  // A recording failure rejects `done`; surface that error, not a fetch timeout.
  const failed = done.then(() => new Promise<never>(() => {}));
  const response = await Promise.race([
    fetch(proxy, {
      method: "POST",
      body: JSON.stringify({ stream }),
      headers: { "content-type": "application/json" },
    }),
    failed,
  ]);
  await Promise.race([response.text(), failed]);
  await done;
  const replay = await mock(undefined, extended);
  const fixtures = loadFixturesFromDir(dir);
  expect(validateFixtures(fixtures).filter((issue) => issue.severity === "error")).toEqual([]);
  replay.addFixtures(fixtures);
  return replay;
}

async function assertUncitedRecording(
  provider: Provider,
  captureStream: boolean,
  replayStream: boolean,
): Promise<void> {
  const blocks = [
    { type: "text", text: "ordinary" },
    { type: "text", text: " answer" },
  ];
  const plain = await recorded(
    provider,
    captureStream ? nativeEvents(provider, blocks) : nativeJSON(provider, blocks),
    captureStream,
  );
  const saved = plain.getFixtures()[0].response as Json;
  expect(saved.blocks).toBeUndefined();
  if (provider === "responses" && !captureStream) {
    // The pinned recorder saves unrecognized uncited Responses JSON as an error fixture.
    expect(saved.error).toMatchObject({ type: "proxy_error" });
    const replay = await fetch(`${plain.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: "cited answer", stream: replayStream }),
    });
    expect(replay.status).toBe(saved.status);
    expect((await replay.json()).error).toMatchObject({ type: "proxy_error" });
  } else {
    expect(saved.content).toBe("ordinary answer");
    expect(visible((await request(plain, provider, replayStream)).body, provider)).toEqual(
      expected([{ type: "text", text: "ordinary answer" }], provider),
    );
  }
}

describe("native citation fixtures", () => {
  it("Responses WebSocket preserves indexed annotations across ordered text and tool blocks", async () => {
    const annotations = [
      { ...urlCitation, extension: { nested: [null, "opaque"] } },
      structuredClone(urlCitation),
      structuredClone(urlCitation),
    ];
    const blocks = [
      tool,
      text("responses", "", annotations),
      { type: "text", text: "ordinary" },
      text("responses", "fact", searchAndPathCitations("responses")),
    ];
    const server = await mock({ blocks });
    const ws = await connectWebSocket(server.url, "/v1/responses");
    cleanups.push(async () => {
      ws.close();
      await ws.waitForClose();
    });
    ws.send(JSON.stringify({ type: "response.create", model: "gpt-4o", input: "cited answer" }));
    let wire: Json[] = [];
    for (let count = 1; ; count++) {
      wire = (await ws.waitForMessages(count)).map((message) => JSON.parse(message));
      expect(wire[count - 1].type).not.toBe("error");
      if (wire[count - 1].type === "response.completed") break;
    }
    const final = wire[wire.length - 1].response;
    expect(visible(final, "responses")).toEqual(expected(blocks, "responses"));
    const expectedEvents: Json[] = [];
    final.output.forEach((item: Json, outputIndex: number) => {
      if (item.type !== "message") return;
      item.content.forEach((part: Json, contentIndex: number) => {
        if (part.type !== "output_text") return;
        const deltas = wire.filter(
          (event) =>
            event.type === "response.output_text.delta" &&
            event.output_index === outputIndex &&
            event.content_index === contentIndex,
        );
        expect(deltas.map((event) => event.delta).join("")).toBe(part.text);
        (part.annotations ?? []).forEach((annotation: Json, annotationIndex: number) => {
          expectedEvents.push({
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            annotation_index: annotationIndex,
            annotation,
          });
        });
      });
    });
    const observed = wire
      .filter((event) => event.type === "response.output_text.annotation.added")
      .map(({ item_id, output_index, content_index, annotation_index, annotation }) => ({
        item_id,
        output_index,
        content_index,
        annotation_index,
        annotation,
      }))
      .sort(
        (a, b) =>
          a.output_index - b.output_index ||
          a.content_index - b.content_index ||
          a.annotation_index - b.annotation_index,
      );
    expect(observed).toEqual(expectedEvents);
  });

  for (const provider of ["responses", "anthropic"] as const) {
    it(`${provider} validates citation-only JSON fixtures without accepting empty uncited blocks`, async () => {
      const server = await mock();
      for (const metadata of [undefined, []]) {
        const block = { type: "text", text: "", [key(provider)]: metadata };
        expect(() =>
          server.addFixturesFromJSON(
            JSON.stringify([{ match: { userMessage: "invalid" }, response: { blocks: [block] } }]),
          ),
        ).toThrow();
        expect(server.getFixtures()).toHaveLength(0);
      }
      const blocks = [text(provider, "")];
      for (const encoded of [false, true]) {
        server.clearFixtures();
        const entries = [
          { match: { userMessage: "cited answer" }, response: { blocks } },
        ] as FixtureFileEntry[];
        server.addFixturesFromJSON(encoded ? JSON.stringify(entries) : entries);
        expect(server.getFixtures()).toHaveLength(1);
        for (const stream of [false, true]) {
          expect(visible((await request(server, provider, stream)).body, provider)).toEqual(
            expected(blocks, provider),
          );
        }
      }
    });
    it(`${provider} accepts empty cited segments through dynamic JSON registration`, async () => {
      const server = await mock();
      const blocks = [text(provider, ""), tool, text(provider, "fact")];
      const response = await fetch(`${server.url}/__aimock/fixtures`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fixtures: [{ match: { userMessage: "cited answer" }, response: { blocks } }],
        }),
      });
      expect(response.status, await response.text()).toBe(200);
      for (const stream of [true, false]) {
        expect(visible((await request(server, provider, stream)).body, provider)).toEqual(
          expected(blocks, provider),
        );
      }
    });
    for (const stream of [false, true]) {
      it(`${provider} ${stream ? "stream" : "JSON"} preserves native fields and multiplicity`, async () => {
        const metadata = [
          ...searchAndPathCitations(provider),
          ...(provider === "responses"
            ? [
                { type: "file_citation", file_id: "file_1", filename: "source.pdf", index: 0 },
                {
                  type: "container_file_citation",
                  container_id: "container_1",
                  file_id: "file_2",
                  filename: "result.txt",
                  start_index: 0,
                  end_index: 4,
                },
              ]
            : [
                {
                  type: "page_location",
                  file_id: null,
                  document_index: 0,
                  document_title: null,
                  cited_text: "fact",
                  start_page_number: 1,
                  end_page_number: 2,
                },
                {
                  type: "content_block_location",
                  file_id: null,
                  document_index: 1,
                  document_title: "source",
                  cited_text: "fact",
                  start_block_index: 0,
                  end_block_index: 1,
                },
              ]),
          cite(provider),
          {
            ...cite(provider),
            ...(provider === "anthropic" ? { document_title: null } : {}),
            extension: { values: [0, false, "", null, { id: "future" }] },
          },
          cite(provider),
        ];
        const blocks = [
          text(provider, "fact", metadata),
          text(provider, " second", [metadata[1]]),
          text(provider, "fact", [metadata[0]]),
        ];
        await assertReplay({ blocks }, blocks, provider, stream);
      });
      it(`${provider} ${stream ? "stream" : "JSON"} composes empty and uncited text with tools and prefixes`, async () => {
        const blocks = [
          text(provider, ""),
          { type: "text", text: "context " },
          tool,
          text(provider, "fact"),
        ];
        const response = {
          blocks,
          reasoning: "Review sources",
          webSearches: ["source"],
          reasoningSignature: "original-signature",
        };
        const server = await mock(response);
        const result = await request(server, provider, stream);
        expect(visible(result.body, provider)).toEqual(expected(blocks, provider));
        if (provider === "responses")
          expect(result.body.output.slice(0, 2).map((item: Json) => item.type)).toEqual([
            "reasoning",
            "web_search_call",
          ]);
        else
          expect(result.body.content[0]).toMatchObject({
            type: "thinking",
            thinking: "Review sources",
            signature: "original-signature",
          });
      });
    }
    it(`${provider} loads authored JSON fixtures with object tool arguments`, async () => {
      const blocks = [
        text(provider, "a"),
        { ...tool, arguments: { query: "source" } },
        text(provider, "b"),
      ];
      const path = join(directory(), "input.json");
      writeFileSync(
        path,
        JSON.stringify({
          fixtures: [{ match: { userMessage: "cited answer" }, response: { blocks } }],
        }),
      );
      const server = await mock();
      server.loadFixtureFile(path);
      expect(visible((await request(server, provider, true)).body, provider)).toEqual(
        expected(blocks, provider),
      );
    });
    it(`${provider} selects only its native metadata without changing input`, async () => {
      const block = {
        type: "text",
        text: "fact",
        annotations: [urlCitation],
        citations: [documentCitation],
      };
      const response = { blocks: [block] };
      const original = structuredClone(response);
      const server = await mock(response);
      for (const stream of [true, false, true]) {
        const result = await request(server, provider, stream);
        expect(visible(result.body, provider)).toEqual(expected([block], provider));
        const native =
          provider === "responses" ? result.body.output[0].content[0] : result.body.content[0];
        expect(native).not.toHaveProperty(provider === "responses" ? "citations" : "annotations");
      }
      expect(response).toEqual(original);
    });
    it(`${provider} does not retain citations for a later uncited response`, async () => {
      const blocks = [text(provider, "fact")];
      const server = await mock({ blocks });
      server.addFixture({ match: { userMessage: "plain" }, response: { content: "plain" } });
      expect(visible((await request(server, provider, true)).body, provider)).toEqual(
        expected(blocks, provider),
      );
      expect(visible((await request(server, provider, true, "plain")).body, provider)).toEqual(
        expected([{ type: "text", text: "plain" }], provider),
      );
    });
    for (const captureStream of [false, true])
      for (const replayStream of [false, true]) {
        it(`${provider} records ${captureStream ? "SSE" : "JSON"}, reloads, and replays ${replayStream ? "SSE" : "JSON"}`, async () => {
          await assertUncitedRecording(provider, captureStream, replayStream);
          const blocks = [
            text(provider, "prefix fact tail", [
              ...searchAndPathCitations(provider),
              {
                ...cite(provider),
                ...(provider === "responses"
                  ? { start_index: 7, end_index: 11 }
                  : { start_char_index: 93, end_char_index: 97 }),
                extension: { nested: [null, false, 0, ""], label: "retained" },
              },
              ...(provider === "responses"
                ? [
                    {
                      type: "file_citation",
                      file_id: "file_recorded",
                      filename: "recorded.pdf",
                      index: 2,
                    },
                    {
                      type: "container_file_citation",
                      container_id: "container_recorded",
                      file_id: "file_result",
                      filename: "result.txt",
                      start_index: 7,
                      end_index: 11,
                    },
                  ]
                : [
                    {
                      type: "page_location",
                      file_id: null,
                      document_index: 2,
                      document_title: "recorded",
                      cited_text: "fact",
                      start_page_number: 3,
                      end_page_number: 4,
                    },
                    {
                      type: "content_block_location",
                      file_id: null,
                      document_index: 1,
                      document_title: null,
                      cited_text: "fact",
                      start_block_index: 2,
                      end_block_index: 3,
                    },
                  ]),
            ]),
            { type: "text", text: " uncited" },
            tool,
            text(provider, ""),
            text(provider, "last", [cite(provider), cite(provider)]),
            text(provider, "last", [{ ...cite(provider), extension: { occurrence: 2 } }]),
            { ...tool, name: "compare", arguments: '{"query":"other"}', id: "call_other" },
          ];
          const json = nativeJSON(provider, blocks);
          if (provider === "responses") {
            json.output[0].content.push(...json.output[1].content);
            json.output.splice(1, 1);
          }
          const wire = nativeEvents(provider, blocks).flatMap((event) => {
            if (event.delta?.type !== "input_json_delta") return [event];
            const args = event.delta.partial_json as string;
            return [args.slice(0, 3), args.slice(3)].map((part) => ({
              ...event,
              delta: { type: "input_json_delta", partial_json: part },
            }));
          });
          const server = await recorded(provider, captureStream ? wire : json, captureStream);
          expect(visible((await request(server, provider, replayStream)).body, provider)).toEqual(
            expected(blocks, provider),
          );
        });
      }
    it(`${provider} persists a citation-only empty text turn`, async () => {
      const blocks = [text(provider, "")];
      const server = await recorded(provider, nativeEvents(provider, blocks), true);
      expect(visible((await request(server, provider, true)).body, provider)).toEqual(
        expected(blocks, provider),
      );
    });
  }

  it("Responses annotation events identify the same final item, content and annotation", async () => {
    const blocks = [tool, text("responses", "fact", [urlCitation, urlCitation])];
    const server = await mock({ blocks, reasoning: "inspect", webSearches: ["source"] });
    const result = await request(server, "responses", true);
    const added = result.events.filter(
      (event) => event.type === "response.output_text.annotation.added",
    );
    expect(added).toHaveLength(2);
    added.forEach((event, index) => {
      const item = result.body.output[event.output_index];
      expect(item.id).toBe(event.item_id);
      expect(event.annotation_index).toBe(index);
      expect(item.content[event.content_index].annotations[index]).toEqual(event.annotation);
      expect(event.annotation).toEqual(urlCitation);
    });
    for (const event of result.events.filter(
      (event) => event.type === "response.content_part.done",
    )) {
      expect(event.part).toEqual(
        result.body.output[event.output_index].content[event.content_index],
      );
    }
  });
  it("Anthropic emits each citation before its own block closes", async () => {
    const server = await mock({
      blocks: [tool, text("anthropic", "one"), text("anthropic", "two")],
    });
    const result = await request(server, "anthropic", true);
    const deltas = result.events.filter((event) => event.delta?.type === "citations_delta");
    expect(deltas).toHaveLength(2);
    for (const event of deltas) {
      const pos = result.events.indexOf(event);
      expect(
        result.events
          .slice(0, pos)
          .some((e) => e.type === "content_block_start" && e.index === event.index),
      ).toBe(true);
      expect(
        result.events
          .slice(pos + 1)
          .some((e) => e.type === "content_block_stop" && e.index === event.index),
      ).toBe(true);
      expect(
        result.events
          .slice(0, pos)
          .some((e) => e.type === "content_block_stop" && e.index === event.index),
      ).toBe(false);
      expect(result.body.content[event.index].citations).toEqual([event.delta.citation]);
    }
  });
  it("Responses correlates content and annotation indexes independently of arrival", async () => {
    const second = { ...urlCitation, url: "https://example.test/second" };
    const input = [
      { type: "response.output_text.delta", output_index: 2, content_index: 1, delta: "second" },
      {
        type: "response.output_text.annotation.added",
        output_index: 2,
        content_index: 1,
        annotation_index: 1,
        annotation: second,
      },
      { type: "response.output_text.delta", output_index: 2, content_index: 0, delta: "first" },
      {
        type: "response.output_text.annotation.added",
        output_index: 2,
        content_index: 0,
        annotation_index: 0,
        annotation: second,
      },
      {
        type: "response.output_text.annotation.added",
        output_index: 2,
        content_index: 1,
        annotation_index: 0,
        annotation: urlCitation,
      },
    ];
    await replayCollapsed("responses", input, [
      text("responses", "first", [second]),
      text("responses", "second", [urlCitation, second]),
    ]);
  });
  it("Responses replaces supplied terminal text and annotations without duplicating snapshots", async () => {
    const final = text("responses", "correct", [urlCitation, urlCitation]);
    const input = nativeEvents("responses", [text("responses", "draft")]).slice(0, -1);
    input.push({
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: final.text, annotations: final.annotations },
    });
    input.push({
      type: "response.output_item.done",
      output_index: 0,
      item: nativeJSON("responses", [final]).output[0],
    });
    input.push({ type: "response.completed", response: nativeJSON("responses", [final]) });
    await replayCollapsed("responses", input, [final]);
  });
  it("Responses records a turn whose terminal metadata clears every citation as uncited", async () => {
    const input = nativeEvents("responses", [text("responses", "draft")]).slice(0, -1);
    input.push({
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "final", annotations: [] },
    });
    const uncited = input.filter((event) => event.type !== "response.output_text.annotation.added");
    expect(collapseOpenAISSE(sse(input))).toEqual(collapseOpenAISSE(sse(uncited)));
    expect(collapseOpenAISSE(sse(input)).blocks).toBeUndefined();
  });

  it("Responses omitted snapshot fields retain accumulated values", async () => {
    const block = text("responses", "retained");
    const input = nativeEvents("responses", [block]).slice(0, -1);
    input.push({
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text" },
    });
    await replayCollapsed("responses", input, [block]);
  });
  it("Responses can capture citations solely from a completed message with multiple parts", async () => {
    const blocks = [text("responses", "first"), text("responses", "second")];
    const response = {
      output: [
        { type: "message", content: blocks.map((block) => ({ ...block, type: "output_text" })) },
      ],
    };
    const server = await recorded("responses", [{ type: "response.completed", response }], true);
    expect(visible((await request(server, "responses", true)).body, "responses")).toEqual(
      expected(blocks, "responses"),
    );
  });
  it("Anthropic appends indexed deltas to initial citations without global deduplication", async () => {
    const a = documentCitation;
    await replayCollapsed(
      "anthropic",
      [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "start", citations: [a] },
        },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "other" } },
        { type: "content_block_delta", index: 1, delta: { type: "citations_delta", citation: a } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " end" } },
        { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation: a } },
      ],
      [text("anthropic", "start end", [a, a]), text("anthropic", "other", [a])],
    );
  });
  it("Responses reconstructs interleaved text and tool deltas by output index", async () => {
    const second = { ...urlCitation, url: "https://example.test/later" };
    await replayCollapsed(
      "responses",
      [
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { type: "function_call", name: "alpha", call_id: "call_alpha", arguments: "" },
        },
        {
          type: "response.output_item.added",
          output_index: 3,
          item: { type: "function_call", name: "beta", call_id: "call_beta", arguments: "" },
        },
        { type: "response.output_text.delta", output_index: 2, content_index: 0, delta: "lat" },
        {
          type: "response.output_text.annotation.added",
          output_index: 2,
          content_index: 0,
          annotation_index: 0,
          annotation: second,
        },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ear" },
        {
          type: "response.output_text.annotation.added",
          output_index: 0,
          content_index: 0,
          annotation_index: 0,
          annotation: urlCitation,
        },
        { type: "response.function_call_arguments.delta", output_index: 3, delta: '{"b":' },
        { type: "response.output_text.delta", output_index: 2, content_index: 0, delta: "er" },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ly" },
        { type: "response.function_call_arguments.delta", output_index: 3, delta: "2}" },
        { type: "response.function_call_arguments.done", output_index: 1, arguments: '{"a":3}' },
      ],
      [
        text("responses", "early"),
        { type: "toolCall", name: "alpha", id: "call_alpha", arguments: '{"a":3}' },
        text("responses", "later", [second]),
        { type: "toolCall", name: "beta", id: "call_beta", arguments: '{"b":2}' },
      ],
    );
  });

  it("Responses accepts terminal text independently of annotation snapshots", async () => {
    const input = nativeEvents("responses", [text("responses", "draft")]).slice(0, -1);
    input.push({ type: "response.output_text.done", output_index: 0, content_index: 0, text: "" });
    await replayCollapsed("responses", input, [text("responses", "")]);
  });

  for (const terminal of [
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
    "response.incomplete",
  ]) {
    for (const field of ["text", "annotations"]) {
      it(`Responses reconciles ${field}-only ${terminal} snapshots`, async () => {
        const original = text("responses", "draft", [
          urlCitation,
          { ...urlCitation, title: "second" },
          urlCitation,
        ]);
        const replacement = { ...urlCitation, url: "https://example.test/revised" };
        const part = {
          type: "output_text",
          ...(field === "text" ? { text: "correct" } : { annotations: [replacement] }),
        };
        const item = { type: "message", content: [part] };
        const event =
          terminal === "response.content_part.done"
            ? { type: terminal, output_index: 0, content_index: 0, part }
            : terminal === "response.output_item.done"
              ? { type: terminal, output_index: 0, item }
              : { type: terminal, response: { output: [item] } };
        const input = nativeEvents("responses", [original]).slice(0, -1);
        input.push(event, structuredClone(event));
        await replayCollapsed("responses", input, [
          text(
            "responses",
            field === "text" ? "correct" : "draft",
            field === "annotations" ? [replacement] : original.annotations,
          ),
        ]);
      });
    }
  }

  for (const provider of ["responses", "anthropic"] as const) {
    for (const captureStream of [false, true]) {
      it(`${provider} records cited reasoning prefixes from ${captureStream ? "SSE" : "JSON"}`, async () => {
        const blocks = [text(provider, "fact"), tool];
        const source = await mock({
          blocks,
          reasoning: "Inspect sources",
          reasoningSignature: "signed-reasoning",
          webSearches: ["source"],
        });
        const wire = await request(source, provider, captureStream);
        const replay = await recorded(
          provider,
          captureStream ? wire.events : wire.body,
          captureStream,
        );
        for (const stream of [false, true]) {
          const result = await request(replay, provider, stream);
          expect(visible(result.body, provider)).toEqual(expected(blocks, provider));
          if (provider === "responses") {
            expect(result.body.output[0]).toMatchObject({
              type: "reasoning",
              summary: [{ type: "summary_text", text: "Inspect sources" }],
            });
            expect(result.body.output[1]).toMatchObject({
              type: "web_search_call",
              action: { query: "source" },
            });
          } else {
            expect(result.body.content[0]).toMatchObject({
              type: "thinking",
              thinking: "Inspect sources",
              signature: "signed-reasoning",
            });
          }
        }
      });
    }
  }
});

describe("native citations with current Responses tool modes", () => {
  // Real Responses usage nests *_details objects; a fixture keeps only the
  // sanitized numeric fields.
  const upstreamUsage = {
    input_tokens: 7,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 10,
  };
  function toolModeTurn(stream: boolean): Json | Json[] {
    const json = nativeJSON("responses", [text("responses", "fact"), tool]);
    json.output[1].namespace = "search";
    json.output.push({
      type: "custom_tool_call",
      call_id: "custom-1",
      name: "code",
      namespace: "sandbox",
      input: "print(1)",
    });
    json.usage = structuredClone(upstreamUsage);
    if (!stream) return json;
    const [, call, custom] = json.output;
    return [
      ...nativeEvents("responses", [text("responses", "fact")]).slice(0, -1),
      { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: call.arguments },
      { type: "response.output_item.done", output_index: 1, item: call },
      { type: "response.output_item.added", output_index: 2, item: { ...custom, input: "" } },
      { type: "response.custom_tool_call_input.delta", output_index: 2, delta: custom.input },
      { type: "response.output_item.done", output_index: 2, item: custom },
      { type: "response.completed", response: json },
    ];
  }
  for (const stream of [false, true]) {
    it(`preserves extended calls, text metadata and sanitized usage while recording ${stream ? "SSE" : "JSON"}`, async () => {
      const server = await recorded("responses", toolModeTurn(stream), stream, true);
      const saved = server.getFixtures()[0].response as Json;
      // JSON capture keeps the sanitized usage exactly; a Responses stream
      // records no usage, cited or not.
      if (stream) expect(saved).not.toHaveProperty("usage");
      else expect(saved.usage).toEqual({ input_tokens: 7, output_tokens: 3, total_tokens: 10 });
      const { body } = await request(server, "responses", false);
      expect(
        body.output.find((item: Json) => item.type === "message").content[0].annotations,
      ).toEqual([urlCitation]);
      expect(body.output.find((item: Json) => item.type === "function_call").namespace).toBe(
        "search",
      );
      expect(body.output.find((item: Json) => item.type === "custom_tool_call")).toMatchObject({
        name: "code",
        namespace: "sandbox",
        input: "print(1)",
      });
      if (!stream)
        expect(body.usage).toMatchObject({ input_tokens: 7, output_tokens: 3, total_tokens: 10 });
    });
    it(`retains citations while dropping extended tool fields in default ${stream ? "SSE" : "JSON"} recording`, async () => {
      const server = await recorded("responses", toolModeTurn(stream), stream);
      const saved = server.getFixtures()[0].response as Json;
      expect(saved).not.toHaveProperty("responsesBlocks");
      expect(saved).not.toHaveProperty("customToolCalls");
      const { body } = await request(server, "responses", false);
      expect(
        body.output.find((item: Json) => item.type === "message").content[0].annotations,
      ).toEqual([urlCitation]);
      expect(
        body.output.find((item: Json) => item.type === "function_call").namespace,
      ).toBeUndefined();
      expect(body.output.some((item: Json) => item.type === "custom_tool_call")).toBe(false);
    });
  }
});

describe("recording shape regressions", () => {
  // A message item with two output_text parts must replay as that one item.
  const parts = [
    { type: "output_text", text: "Fact one. ", annotations: [urlCitation] },
    {
      type: "output_text",
      text: "Fact two.",
      annotations: [{ ...urlCitation, url: "https://example.test/second" }],
    },
  ];
  const multiPart = {
    output: [{ type: "message", role: "assistant", content: parts }],
    usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
  };
  for (const captureStream of [false, true])
    for (const replayStream of [false, true])
      it(`Responses replays a cited multi-part message as one item (${captureStream ? "SSE" : "JSON"} capture, ${replayStream ? "SSE" : "JSON"} replay)`, async () => {
        const server = await recorded(
          "responses",
          captureStream
            ? [{ type: "response.completed", response: structuredClone(multiPart) }]
            : structuredClone(multiPart),
          captureStream,
        );
        const { body } = await request(server, "responses", replayStream);
        const messages = body.output.filter((item: Json) => item.type === "message");
        expect(messages).toHaveLength(1);
        expect(
          messages[0].content.map(({ type, text, annotations }: Json) => ({
            type,
            text,
            annotations,
          })),
        ).toEqual(parts);
      });

  it("Responses JSON replay keeps separately recorded text blocks as separate messages", async () => {
    const server = await mock({
      content: "One. Two.",
      toolCalls: [],
      blocks: [text("responses", "One. "), text("responses", "Two.")],
    });
    const { body } = await request(server, "responses", false);
    expect(body.output.map((item: Json) => item.content.length)).toEqual([1, 1]);
  });

  it("an uncited interleaved extended Responses stream records the pre-citation fixture shape", async () => {
    const message = (output_index: number, value: string): Json[] => [
      {
        type: "response.output_item.added",
        output_index,
        item: { type: "message", role: "assistant", content: [] },
      },
      {
        type: "response.content_part.added",
        output_index,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      { type: "response.output_text.delta", output_index, content_index: 0, delta: value },
      { type: "response.output_text.done", output_index, content_index: 0, text: value },
    ];
    const wire = [
      ...message(0, "Before "),
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", name: "lookup", call_id: "call_1", arguments: "" },
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 1,
        arguments: '{"q":"x"}',
      },
      {
        type: "response.output_item.added",
        output_index: 2,
        item: { type: "custom_tool_call", name: "patch", call_id: "call_2", input: "" },
      },
      { type: "response.custom_tool_call_input.done", output_index: 2, input: "diff" },
      ...message(3, "after"),
    ];
    const server = await recorded("responses", wire, true, true);
    const saved = server.getFixtures()[0].response as Json;
    expect(Object.keys(saved).sort()).toEqual([
      "content",
      "customToolCalls",
      "responsesBlocks",
      "toolCalls",
    ]);
  });
});

describe("a cited recording is the uncited recording plus its citations", () => {
  const saved = (server: LLMock) => server.getFixtures()[0].response as Json;
  const webCitation = searchAndPathCitations("anthropic")[0];
  const anthropicText = (index: number, value: string, citations: Json[]): Json[] => [
    {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "", citations: [] },
    },
    ...(value
      ? [{ type: "content_block_delta", index, delta: { type: "text_delta", text: value } }]
      : []),
    ...citations.map((citation) => ({
      type: "content_block_delta",
      index,
      delta: { type: "citations_delta", citation },
    })),
    { type: "content_block_stop", index },
  ];
  const responsesMessage = (output_index: number, parts: Json[]): Json[] => [
    {
      type: "response.output_item.added",
      output_index,
      item: { type: "message", role: "assistant", content: [] },
    },
    ...parts.flatMap((part, content_index) => [
      {
        type: "response.content_part.added",
        output_index,
        content_index,
        part: { type: "output_text", text: "", annotations: [] },
      },
      ...(part.text
        ? [{ type: "response.output_text.delta", output_index, content_index, delta: part.text }]
        : []),
      ...(part.annotations ?? []).map((annotation: Json, annotation_index: number) => ({
        type: "response.output_text.annotation.added",
        output_index,
        content_index,
        annotation_index,
        annotation,
      })),
    ]),
    {
      type: "response.output_item.done",
      output_index,
      item: {
        type: "message",
        role: "assistant",
        content: parts.map((part) => ({ type: "output_text", annotations: [], ...part })),
      },
    },
  ];
  const functionCall = (output_index: number, args: string, extra: Json = {}): Json[] => {
    const item = {
      type: "function_call",
      name: "lookup",
      call_id: "call_1",
      arguments: args,
      ...extra,
    };
    return [
      { type: "response.output_item.added", output_index, item: { ...item, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index, delta: args },
      { type: "response.output_item.done", output_index, item },
    ];
  };
  const completed = (events: Json[]): Json => ({
    type: "response.completed",
    response: {
      output: events.filter((e) => e.type === "response.output_item.done").map((e) => e.item),
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    },
  });
  const withCompleted = (events: Json[]): Json[] => [...events, completed(events)];
  /** The same wire with every citation removed: what an uncited turn sends. */
  const uncited = (events: Json[]): Json[] =>
    events
      .filter(
        (e) =>
          e.type !== "response.output_text.annotation.added" && e.delta?.type !== "citations_delta",
      )
      .map((e) =>
        e.type === "response.completed" || e.type === "response.output_item.done"
          ? JSON.parse(JSON.stringify(e).replace(/"annotations":\[[^\]]*\]/g, '"annotations":[]'))
          : e,
      );
  const withoutBlocks = (result: Json): Json => {
    const copy = { ...result };
    delete copy.blocks;
    return copy;
  };

  it("Anthropic web search records no tool call for its server_tool_use input", async () => {
    const wire = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":"fact"}' },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] },
      },
      { type: "content_block_stop", index: 1 },
      ...anthropicText(2, "fact", [webCitation]),
    ];
    const server = await recorded("anthropic", wire, true);
    expect(saved(server)).toEqual({
      content: "fact",
      blocks: [text("anthropic", "fact", [webCitation])],
    });
    const replay = await request(server, "anthropic", true);
    expect(replay.body.content.map((block: Json) => block.type)).toEqual(["text"]);
  });

  for (const stream of [false, true])
    it(`Anthropic ${stream ? "SSE" : "JSON"} leaves out an empty uncited text block`, async () => {
      const wire = stream
        ? [...anthropicText(0, "", []), ...anthropicText(1, "fact", [documentCitation])]
        : {
            content: [
              { type: "text", text: "", citations: [] },
              { type: "text", text: "fact", citations: [documentCitation] },
            ],
          };
      const server = await recorded("anthropic", wire, stream);
      expect(saved(server)).toEqual({
        content: "fact",
        blocks: [text("anthropic", "fact", [documentCitation])],
      });
    });

  it("Anthropic normalizes whitespace-only tool arguments and keeps an index-less tool_use", async () => {
    const wire = [
      ...anthropicText(0, "fact", [documentCitation]),
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "first", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: " " },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        content_block: { type: "tool_use", id: "toolu_2", name: "second", input: {} },
      },
      { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"q":1}' } },
      { type: "content_block_stop" },
    ];
    const toolCalls = [
      { name: "first", arguments: "{}", id: "toolu_1" },
      { name: "second", arguments: '{"q":1}', id: "toolu_2" },
    ];
    expect(collapseAnthropicSSE(sse(wire))).toEqual({
      content: "fact",
      toolCalls,
      blocks: [
        text("anthropic", "fact", [documentCitation]),
        ...toolCalls.map((call) => ({ type: "toolCall", ...call })),
      ],
    });
    const server = await recorded("anthropic", wire, true);
    expect(saved(server).toolCalls).toEqual(toolCalls);
  });

  it("Responses drops an empty namespace and normalizes whitespace-only arguments", async () => {
    const wire = withCompleted([
      ...responsesMessage(0, [{ text: "fact", annotations: [urlCitation] }]),
      ...functionCall(1, " ", { namespace: "" }),
    ]);
    const server = await recorded("responses", wire, true, true);
    expect(saved(server)).toEqual({
      content: "fact",
      toolCalls: [{ name: "lookup", arguments: "{}", id: "call_1" }],
      blocks: [
        text("responses", "fact", [urlCitation]),
        { type: "toolCall", name: "lookup", arguments: "{}", id: "call_1" },
      ],
    });
  });

  for (const stream of [false, true])
    it(`Responses ${stream ? "SSE" : "JSON"} text-only turn records no empty toolCalls`, async () => {
      const events = withCompleted(
        responsesMessage(0, [{ text: "fact", annotations: [urlCitation] }]),
      );
      const server = await recorded(
        "responses",
        stream ? events : events[events.length - 1].response,
        stream,
      );
      expect(saved(server)).toEqual({
        content: "fact",
        blocks: [text("responses", "fact", [urlCitation])],
        ...(stream ? {} : { usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } }),
      });
    });

  it("Responses leaves out an opened output_text part that never received text", async () => {
    const wire = withCompleted(
      responsesMessage(0, [{ text: "fact", annotations: [urlCitation] }, { text: "" }]),
    );
    const server = await recorded("responses", wire, true);
    expect(saved(server).blocks).toEqual([text("responses", "fact", [urlCitation])]);
  });

  it("Responses keeps what the uncited recording keeps of refusal parts and logprobs", async () => {
    const parts = [
      { type: "refusal", refusal: "no" },
      {
        type: "output_text",
        text: "but fact",
        annotations: [urlCitation],
        logprobs: [{ token: "but", logprob: -0.1, bytes: [98, 117, 116], top_logprobs: [] }],
      },
    ];
    const wire = withCompleted([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", content: [] },
      },
      { type: "response.refusal.delta", output_index: 0, content_index: 0, delta: "no" },
      { type: "response.output_text.delta", output_index: 0, content_index: 1, delta: "but fact" },
      {
        type: "response.output_text.annotation.added",
        output_index: 0,
        content_index: 1,
        annotation_index: 0,
        annotation: urlCitation,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", content: parts },
      },
    ]);
    const cited = collapseOpenAISSE(sse(wire));
    expect(withoutBlocks(cited)).toEqual(collapseOpenAISSE(sse(uncited(wire))));
    expect(cited.blocks).toEqual([text("responses", "but fact", [urlCitation])]);
  });

  it("Responses JSON tolerates null output and summary entries", async () => {
    const server = await recorded(
      "responses",
      {
        output: [
          null,
          { type: "reasoning", summary: [null, { type: "summary_text", text: "think" }] },
          {
            type: "message",
            content: [{ type: "output_text", text: "fact", annotations: [urlCitation] }],
          },
        ],
      },
      false,
    );
    expect(saved(server)).toEqual({
      content: "fact",
      blocks: [text("responses", "fact", [urlCitation])],
      reasoning: "think",
    });
  });

  it("a citation-only empty turn records without an empty-content warning", async () => {
    const logger = new Logger("silent");
    const warn = vi.spyOn(logger, "warn");
    const wire = withCompleted(responsesMessage(0, [{ text: "", annotations: [urlCitation] }]));
    const server = await recorded("responses", wire, true, false, logger);
    expect(saved(server).blocks).toEqual([text("responses", "", [urlCitation])]);
    expect(warn.mock.calls.flat().join("\n")).not.toContain("empty content");
  });

  for (const extended of [false, true])
    it(`Responses ${extended ? "extended" : "default"} mode keeps text and tool order around a custom call`, async () => {
      const wire = withCompleted([
        ...responsesMessage(0, [{ text: "before", annotations: [urlCitation] }]),
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { type: "custom_tool_call", name: "patch", call_id: "custom-1", input: "" },
        },
        { type: "response.custom_tool_call_input.delta", output_index: 1, delta: "diff" },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: { type: "custom_tool_call", name: "patch", call_id: "custom-1", input: "diff" },
        },
        ...functionCall(2, '{"q":1}'),
        ...responsesMessage(3, [{ text: "after" }]),
      ]);
      const server = await recorded("responses", wire, true, extended);
      const fixture = saved(server);
      const ordered = [
        text("responses", "before", [urlCitation]),
        ...(extended
          ? [{ type: "customToolCall", name: "patch", input: "diff", id: "custom-1" }]
          : []),
        { type: "toolCall", name: "lookup", arguments: '{"q":1}', id: "call_1" },
        { type: "text", text: "after" },
      ];
      if (extended) {
        expect(fixture).not.toHaveProperty("blocks");
        expect(fixture.responsesBlocks).toEqual(ordered);
      } else {
        expect(fixture).not.toHaveProperty("responsesBlocks");
        expect(fixture.blocks).toEqual(ordered);
      }
    });

  it("public collapse functions return the uncited result plus blocks for cited input", () => {
    const responses = [
      withCompleted(responsesMessage(0, [{ text: "Hi", annotations: [urlCitation] }])),
      withCompleted([
        ...functionCall(0, '{"q":1}', { namespace: "ns" }),
        ...responsesMessage(1, [{ text: "after", annotations: [urlCitation] }]),
      ]),
      withCompleted([
        ...responsesMessage(0, [{ text: "Hi", annotations: [urlCitation] }, { text: "" }]),
        ...functionCall(1, " ", { namespace: "" }),
      ]),
    ];
    for (const wire of responses) {
      for (const collapse of [
        collapseOpenAISSE,
        (body: string) => collapseStreamingResponse("text/event-stream", "openai", body)!,
      ]) {
        const cited = collapse(sse(wire));
        const plain = collapse(sse(uncited(wire)));
        expect(withoutBlocks(cited)).toEqual(withoutBlocks(plain));
        expect(cited.blocks?.some((block) => block.type === "text" && block.annotations)).toBe(
          true,
        );
      }
    }
    const anthropic = [
      [...anthropicText(0, "", []), ...anthropicText(1, "fact", [documentCitation])],
      [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "server_tool_use", id: "s", name: "web_search", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{}" },
        },
        ...anthropicText(1, "fact", [webCitation]),
      ],
    ];
    for (const wire of anthropic) {
      const cited = collapseAnthropicSSE(sse(wire));
      expect(withoutBlocks(cited)).toEqual(collapseAnthropicSSE(sse(uncited(wire))));
      expect(cited.blocks?.length).toBeGreaterThan(0);
    }
  });

  for (const stream of [false, true])
    it(`Bedrock InvokeModel ${stream ? "stream" : "JSON"} serves no native citations under a misbehavior`, async () => {
      const server = new MisbehaviorLLMock({ port: 0, latency: 0 });
      server.addFixture({
        match: {},
        response: {
          blocks: [
            text("anthropic", "fact", [documentCitation]),
            { type: "toolCall", name: "lookup", arguments: '{"q":1}', id: "toolu_fixed" },
          ],
        } as FixtureResponse,
        misbehavior: { faults: [{ fault: "tool-unknown-name" }] },
      });
      await server.start();
      cleanups.push(() => server.stop());
      const response = await fetch(
        `${server.url}/model/anthropic.claude-3-sonnet-20240229-v1:0/${stream ? "invoke-with-response-stream" : "invoke"}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 64,
            messages: [{ role: "user", content: "lookup" }],
          }),
        },
      );
      expect(response.status).toBe(200);
      const raw = Buffer.from(await response.arrayBuffer()).toString("latin1");
      const served = stream
        ? [...raw.matchAll(/"bytes":"([A-Za-z0-9+/=]+)"/g)]
            .map((match) => Buffer.from(match[1], "base64").toString("utf8"))
            .join("\n")
        : raw;
      expect(served).toContain("lookup_v2");
      expect(served).not.toContain("citations");
    });

  it("rejects malformed native citation fields at load and at serve time", async () => {
    const dir = directory();
    const invalid: Json[] = [
      { type: "text", text: "fact", annotations: { type: "url_citation" } },
      { type: "text", text: "fact", annotations: [null, "x", 3] },
      { type: "text", text: "fact", citations: [1] },
      { type: "text", text: "fact", continuesMessage: "true" },
      { type: "text", text: "", annotations: [null] },
    ];
    invalid.forEach((block, index) =>
      writeFileSync(
        join(dir, `${index}.json`),
        JSON.stringify({
          fixtures: [{ match: { userMessage: "x" }, response: { blocks: [block] } }],
        }),
      ),
    );
    for (let index = 0; index < invalid.length; index++) {
      const errors = validateFixtures(loadFixtureFile(join(dir, `${index}.json`)))
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.message);
      expect(
        errors.some((message) => /annotations|citations|continuesMessage/.test(message)),
        JSON.stringify(errors),
      ).toBe(true);
    }
    for (const block of [
      { type: "text", text: "fact", annotations: [{ type: "url_citation", read: () => 1 }] },
      { type: "text", text: "fact", annotations: { type: "url_citation" } },
      { type: "text", text: "fact", continuesMessage: "true" },
    ]) {
      const server = await mock({ blocks: [block] });
      const response = await fetch(`${server.url}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", input: "cited answer" }),
      });
      expect(response.status).toBe(500);
      expect((await response.json()).error.message).toMatch(/^Invalid fixture block at index 0: /);
    }
  });
});
