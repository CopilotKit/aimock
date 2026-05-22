import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AGUIEvent, AGUIRunAgentInput } from "../agui-types.js";
import { AGUIMock } from "../agui-mock.js";
import {
  buildTextResponse,
  buildToolCallResponse,
  buildStateUpdate,
  buildStateDelta,
  buildMessagesSnapshot,
  buildReasoningResponse,
  buildActivityResponse,
  buildErrorResponse,
  buildStepWithText,
  buildCompositeResponse,
  buildTextChunkResponse,
  extractLastUserMessage,
  getLastMessageIfToolResult,
  matchesFixture,
} from "../agui-handler.js";
import { NO_USER_MESSAGE_SENTINEL } from "../agui-recorder.js";
import { LLMock } from "../llmock.js";
import { Journal } from "../journal.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSSEEvents(body: string): AGUIEvent[] {
  return body
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)));
}

function post(
  url: string,
  body: object,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
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
        let responseBody = "";
        res.on("data", (chunk: Buffer) => (responseBody += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: responseBody, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function postRaw(
  url: string,
  rawBody: string,
  contentType?: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": contentType ?? "text/plain",
          "Content-Length": Buffer.byteLength(rawBody),
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk: Buffer) => (responseBody += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: responseBody, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

function aguiInput(userMessage: string, extra?: Partial<AGUIRunAgentInput>): AGUIRunAgentInput {
  return {
    threadId: "test-thread",
    runId: "test-run",
    messages: [{ id: "msg-1", role: "user", content: userMessage }],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let agui: AGUIMock | null = null;
let llmock: LLMock | null = null;

afterEach(async () => {
  if (agui) {
    try {
      await agui.stop();
    } catch {
      /* already stopped */
    }
    agui = null;
  }
  if (llmock) {
    try {
      await llmock.stop();
    } catch {
      /* already stopped */
    }
    llmock = null;
  }
});

// ---------------------------------------------------------------------------
// Core tests (1-14)
// ---------------------------------------------------------------------------

describe("AGUIMock core", () => {
  it("1. standalone start/stop", async () => {
    agui = new AGUIMock({ port: 0 });
    const url = await agui.start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(agui.url).toBe(url);
    await agui.stop();
    expect(() => agui!.url).toThrow("not started");
    agui = null; // prevent afterEach double-stop
  });

  it("2. text response", async () => {
    agui = new AGUIMock({ port: 0 });
    agui.onMessage("hello", "Hi!");
    await agui.start();

    const resp = await post(agui.url, aguiInput("hello"));
    expect(resp.status).toBe(200);
    expect(resp.headers["content-type"]).toBe("text/event-stream");

    const events = parseSSEEvents(resp.body);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);

    const content = events.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as unknown as Record<
      string,
      unknown
    >;
    expect(content.delta).toBe("Hi!");
  });

  it("3. tool call", async () => {
    agui = new AGUIMock({ port: 0 });
    agui.onToolCall(/search/, "web_search", '{"q":"test"}', { result: "[]" });
    await agui.start();

    const resp = await post(agui.url, aguiInput("search for stuff"));
    expect(resp.status).toBe(200);

    const events = parseSSEEvents(resp.body);
    const types = events.map((e) => e.type);
    expect(types).toContain("TOOL_CALL_START");
    expect(types).toContain("TOOL_CALL_ARGS");
    expect(types).toContain("TOOL_CALL_END");
    expect(types).toContain("TOOL_CALL_RESULT");

    const start = events.find((e) => e.type === "TOOL_CALL_START") as unknown as Record<
      string,
      unknown
    >;
    expect(start.toolCallName).toBe("web_search");

    const args = events.find((e) => e.type === "TOOL_CALL_ARGS") as unknown as Record<
      string,
      unknown
    >;
    expect(args.delta).toBe('{"q":"test"}');

    const result = events.find((e) => e.type === "TOOL_CALL_RESULT") as unknown as Record<
      string,
      unknown
    >;
    expect(result.content).toBe("[]");
  });

  it("4. state snapshot", async () => {
    agui = new AGUIMock({ port: 0 });
    agui.onStateKey("counter", { counter: 42 });
    await agui.start();

    const resp = await post(agui.url, {
      messages: [{ role: "user", content: "increment" }],
      state: { counter: 10 },
    });
    expect(resp.status).toBe(200);

    const events = parseSSEEvents(resp.body);
    const snapshot = events.find((e) => e.type === "STATE_SNAPSHOT") as unknown as Record<
      string,
      unknown
    >;
    expect(snapshot).toBeDefined();
    expect(snapshot.snapshot).toEqual({ counter: 42 });
  });

  it("5. state delta", async () => {
    agui = new AGUIMock({ port: 0 });
    const patches = [{ op: "replace", path: "/counter", value: 43 }];
    const events = buildStateDelta(patches);
    agui.addFixture({
      match: { stateKey: "counter" },
      events,
    });
    await agui.start();

    const resp = await post(agui.url, {
      messages: [],
      state: { counter: 42 },
    });
    expect(resp.status).toBe(200);

    const parsed = parseSSEEvents(resp.body);
    const delta = parsed.find((e) => e.type === "STATE_DELTA") as unknown as Record<
      string,
      unknown
    >;
    expect(delta).toBeDefined();
    expect(delta.delta).toEqual(patches);
  });

  it("6. messages snapshot", async () => {
    agui = new AGUIMock({ port: 0 });
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const events = buildMessagesSnapshot(msgs);
    agui.addFixture({
      match: { message: "snapshot" },
      events,
    });
    await agui.start();

    const resp = await post(agui.url, aguiInput("get snapshot"));
    expect(resp.status).toBe(200);

    const parsed = parseSSEEvents(resp.body);
    const snap = parsed.find((e) => e.type === "MESSAGES_SNAPSHOT") as unknown as Record<
      string,
      unknown
    >;
    expect(snap).toBeDefined();
    expect(snap.messages).toEqual(msgs);
  });

  it("7. raw events", async () => {
    agui = new AGUIMock({ port: 0 });
    const rawEvents: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "raw text" },
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r1" },
    ];
    agui.onRun("custom", rawEvents);
    await agui.start();

    const resp = await post(agui.url, aguiInput("custom request"));
    expect(resp.status).toBe(200);

    const parsed = parseSSEEvents(resp.body);
    expect(parsed.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    // Verify the exact threadId/runId we specified
    const started = parsed[0] as unknown as Record<string, unknown>;
    expect(started.threadId).toBe("t1");
    expect(started.runId).toBe("r1");
  });

  it("8. predicate matching", async () => {
    agui = new AGUIMock({ port: 0 });
    const events = buildTextResponse("predicate matched");
    agui.onPredicate(
      (input) => input.state?.["mode" as keyof typeof input.state] === "test",
      events,
    );
    await agui.start();

    const resp = await post(agui.url, {
      messages: [{ role: "user", content: "anything" }],
      state: { mode: "test" },
    });
    expect(resp.status).toBe(200);

    const parsed = parseSSEEvents(resp.body);
    const content = parsed.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as unknown as Record<
      string,
      unknown
    >;
    expect(content.delta).toBe("predicate matched");
  });

  it("9. no match returns 404", async () => {
    agui = new AGUIMock({ port: 0 });
    agui.onMessage("specific", "response");
    await agui.start();

    const resp = await post(agui.url, aguiInput("no match here"));
    expect(resp.status).toBe(404);
    const body = JSON.parse(resp.body);
    expect(body.error).toContain("No matching");
  });

  it("10. mounted on LLMock", async () => {
    llmock = new LLMock({ port: 0 });
    agui = new AGUIMock();
    agui.onMessage("hello", "Hi from mount!");
    llmock.mount("/agui", agui);
    await llmock.start();

    const resp = await post(`${llmock.url}/agui`, aguiInput("hello"));
    expect(resp.status).toBe(200);

    const events = parseSSEEvents(resp.body);
    const types = events.map((e) => e.type);
    expect(types).toContain("TEXT_MESSAGE_CONTENT");
    const content = events.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as unknown as Record<
      string,
      unknown
    >;
    expect(content.delta).toBe("Hi from mount!");
  });

  it("11. journal integration", async () => {
    agui = new AGUIMock({ port: 0 });
    const journal = new Journal();
    agui.setJournal(journal);
    agui.onMessage("hello", "Hi!");
    await agui.start();

    await post(agui.url, aguiInput("hello"));

    const entries = journal.getAll();
    expect(entries.length).toBe(1);
    expect(entries[0].service).toBe("agui");
    expect(entries[0].response.status).toBe(200);
  });

  it("12. timing (delayMs)", async () => {
    agui = new AGUIMock({ port: 0 });
    agui.onMessage("slow", "delayed", { delayMs: 50 });
    await agui.start();

    const start = Date.now();
    const resp = await post(agui.url, aguiInput("slow request"));
    const elapsed = Date.now() - start;

    expect(resp.status).toBe(200);
    // 5 events * 50ms = 250ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });

  it("13. reset clears fixtures", async () => {
    agui = new AGUIMock({ port: 0 });
    agui.onMessage("hello", "Hi!");
    agui.reset();
    await agui.start();

    const resp = await post(agui.url, aguiInput("hello"));
    expect(resp.status).toBe(404);
  });

  it("14. threadId/runId propagation", async () => {
    agui = new AGUIMock({ port: 0 });
    const events = buildTextResponse("ok", {
      threadId: "thread-abc",
      runId: "run-xyz",
    });
    agui.addFixture({ match: { message: "prop" }, events });
    await agui.start();

    const resp = await post(agui.url, aguiInput("prop test"));
    const parsed = parseSSEEvents(resp.body);

    const started = parsed.find((e) => e.type === "RUN_STARTED") as unknown as Record<
      string,
      unknown
    >;
    expect(started.threadId).toBe("thread-abc");
    expect(started.runId).toBe("run-xyz");

    const finished = parsed.find((e) => e.type === "RUN_FINISHED") as unknown as Record<
      string,
      unknown
    >;
    expect(finished.threadId).toBe("thread-abc");
    expect(finished.runId).toBe("run-xyz");
  });
});

// ---------------------------------------------------------------------------
// Builder tests (15-19)
// ---------------------------------------------------------------------------

describe("AGUIMock builders", () => {
  it("15. each builder produces correct event types", () => {
    // buildTextResponse
    const text = buildTextResponse("hello");
    expect(text.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    const textContent = text.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as unknown as Record<
      string,
      unknown
    >;
    expect(textContent.delta).toBe("hello");

    // buildToolCallResponse
    const tool = buildToolCallResponse("search", '{"q":"x"}', { result: "found" });
    const toolTypes = tool.map((e) => e.type);
    expect(toolTypes).toContain("TOOL_CALL_START");
    expect(toolTypes).toContain("TOOL_CALL_ARGS");
    expect(toolTypes).toContain("TOOL_CALL_END");
    expect(toolTypes).toContain("TOOL_CALL_RESULT");
    const toolStart = tool.find((e) => e.type === "TOOL_CALL_START") as unknown as Record<
      string,
      unknown
    >;
    expect(toolStart.toolCallName).toBe("search");

    // buildToolCallResponse without result
    const toolNoResult = buildToolCallResponse("fn", "{}");
    expect(toolNoResult.map((e) => e.type)).not.toContain("TOOL_CALL_RESULT");

    // buildStateUpdate
    const state = buildStateUpdate({ x: 1 });
    expect(state.map((e) => e.type)).toEqual(["RUN_STARTED", "STATE_SNAPSHOT", "RUN_FINISHED"]);
    const snap = state.find((e) => e.type === "STATE_SNAPSHOT") as unknown as Record<
      string,
      unknown
    >;
    expect(snap.snapshot).toEqual({ x: 1 });

    // buildStateDelta
    const delta = buildStateDelta([{ op: "add", path: "/y", value: 2 }]);
    expect(delta.map((e) => e.type)).toEqual(["RUN_STARTED", "STATE_DELTA", "RUN_FINISHED"]);

    // buildMessagesSnapshot
    const msgs = buildMessagesSnapshot([{ role: "user", content: "hi" }]);
    expect(msgs.map((e) => e.type)).toEqual(["RUN_STARTED", "MESSAGES_SNAPSHOT", "RUN_FINISHED"]);

    // buildErrorResponse
    const err = buildErrorResponse("something broke", "ERR_500");
    expect(err.map((e) => e.type)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
    const errEvent = err.find((e) => e.type === "RUN_ERROR") as unknown as Record<string, unknown>;
    expect(errEvent.message).toBe("something broke");
    expect(errEvent.code).toBe("ERR_500");

    // buildStepWithText
    const step = buildStepWithText("analyze", "step result");
    expect(step.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "STEP_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "STEP_FINISHED",
      "RUN_FINISHED",
    ]);
    const stepStarted = step.find((e) => e.type === "STEP_STARTED") as unknown as Record<
      string,
      unknown
    >;
    expect(stepStarted.stepName).toBe("analyze");

    // buildReasoningResponse
    const reasoning = buildReasoningResponse("thinking...");
    expect(reasoning.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "RUN_FINISHED",
    ]);
    const reasonContent = reasoning.find(
      (e) => e.type === "REASONING_MESSAGE_CONTENT",
    ) as unknown as Record<string, unknown>;
    expect(reasonContent.delta).toBe("thinking...");

    // buildActivityResponse
    const activity = buildActivityResponse("msg-1", "progress", { percent: 50 });
    expect(activity.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "ACTIVITY_SNAPSHOT",
      "RUN_FINISHED",
    ]);
    const actSnap = activity.find((e) => e.type === "ACTIVITY_SNAPSHOT") as unknown as Record<
      string,
      unknown
    >;
    expect(actSnap.activityType).toBe("progress");
    expect(actSnap.content).toEqual({ percent: 50 });
  });

  it("16. buildCompositeResponse wraps multiple builder outputs", () => {
    const text = buildTextResponse("hello");
    const tool = buildToolCallResponse("fn", "{}");
    const composite = buildCompositeResponse([text, tool]);

    const types = composite.map((e) => e.type);
    // Should have exactly one RUN_STARTED and one RUN_FINISHED
    expect(types.filter((t) => t === "RUN_STARTED")).toHaveLength(1);
    expect(types.filter((t) => t === "RUN_FINISHED")).toHaveLength(1);
    expect(types[0]).toBe("RUN_STARTED");
    expect(types[types.length - 1]).toBe("RUN_FINISHED");

    // Should contain inner events from both builders
    expect(types).toContain("TEXT_MESSAGE_START");
    expect(types).toContain("TEXT_MESSAGE_CONTENT");
    expect(types).toContain("TOOL_CALL_START");
    expect(types).toContain("TOOL_CALL_ARGS");
  });

  it("17. CHUNK events stream correctly", async () => {
    agui = new AGUIMock({ port: 0 });
    const chunkEvents = buildTextChunkResponse("chunked text");
    agui.addFixture({ match: { message: "chunk" }, events: chunkEvents });
    await agui.start();

    const resp = await post(agui.url, aguiInput("chunk me"));
    expect(resp.status).toBe(200);

    const events = parseSSEEvents(resp.body);
    const types = events.map((e) => e.type);
    expect(types).toContain("TEXT_MESSAGE_CHUNK");
    const chunk = events.find((e) => e.type === "TEXT_MESSAGE_CHUNK") as unknown as Record<
      string,
      unknown
    >;
    expect(chunk.delta).toBe("chunked text");
  });

  it("18. reasoning sequence", async () => {
    agui = new AGUIMock({ port: 0 });
    agui.onReasoning("think", "reasoning text");
    await agui.start();

    const resp = await post(agui.url, aguiInput("think about this"));
    expect(resp.status).toBe(200);

    const events = parseSSEEvents(resp.body);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "RUN_STARTED",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "RUN_FINISHED",
    ]);
    const content = events.find((e) => e.type === "REASONING_MESSAGE_CONTENT") as unknown as Record<
      string,
      unknown
    >;
    expect(content.delta).toBe("reasoning text");
  });

  it("19. activity events", async () => {
    agui = new AGUIMock({ port: 0 });
    const events = buildActivityResponse("act-1", "loading", { step: "fetching" });
    agui.addFixture({ match: { message: "activity" }, events });
    await agui.start();

    const resp = await post(agui.url, aguiInput("show activity"));
    expect(resp.status).toBe(200);

    const parsed = parseSSEEvents(resp.body);
    const act = parsed.find((e) => e.type === "ACTIVITY_SNAPSHOT") as unknown as Record<
      string,
      unknown
    >;
    expect(act).toBeDefined();
    expect(act.activityType).toBe("loading");
    expect(act.content).toEqual({ step: "fetching" });
  });
});

// ---------------------------------------------------------------------------
// Edge cases (20-26)
// ---------------------------------------------------------------------------

describe("AGUIMock edge cases", () => {
  it("20. client disconnect mid-stream does not crash", async () => {
    agui = new AGUIMock({ port: 0 });
    // Use delay to give us time to disconnect
    agui.onMessage("slow", "delayed response", { delayMs: 100 });
    await agui.start();

    await new Promise<void>((resolve) => {
      const parsed = new URL(agui!.url);
      const data = JSON.stringify(aguiInput("slow stream"));
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
          // Read first chunk then destroy
          res.once("data", () => {
            req.destroy();
            // Give the server a moment to notice the disconnect
            setTimeout(resolve, 150);
          });
        },
      );
      req.write(data);
      req.end();
    });

    // Server should still be responsive
    agui.onMessage("after", "still alive");
    // Clear existing fixture first — we want to verify the server is still up
    const resp = await post(agui.url, aguiInput("after disconnect"));
    expect(resp.status).toBe(200);
  });

  it("21. invalid POST body returns 400", async () => {
    agui = new AGUIMock({ port: 0 });
    await agui.start();

    const resp = await postRaw(agui.url, "not json {{{{", "application/json");
    expect(resp.status).toBe(400);
    const body = JSON.parse(resp.body);
    expect(body.error).toContain("Invalid JSON");
  });

  it("22. multiple sequential runs in one fixture", async () => {
    agui = new AGUIMock({ port: 0 });
    // Manually construct events with two RUN_STARTED/RUN_FINISHED pairs
    const events: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "first" },
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r1" },
      { type: "RUN_STARTED", threadId: "t1", runId: "r2" },
      { type: "TEXT_MESSAGE_START", messageId: "m2", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m2", delta: "second" },
      { type: "TEXT_MESSAGE_END", messageId: "m2" },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r2" },
    ];
    agui.addFixture({ match: { message: "multi" }, events });
    await agui.start();

    const resp = await post(agui.url, aguiInput("multi run"));
    expect(resp.status).toBe(200);

    const parsed = parseSSEEvents(resp.body);
    const runStarted = parsed.filter((e) => e.type === "RUN_STARTED");
    const runFinished = parsed.filter((e) => e.type === "RUN_FINISHED");
    expect(runStarted).toHaveLength(2);
    expect(runFinished).toHaveLength(2);
  });

  it("23. deprecated THINKING events stream", async () => {
    agui = new AGUIMock({ port: 0 });
    const events: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
      { type: "THINKING_TEXT_MESSAGE_START" },
      { type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "pondering..." },
      { type: "THINKING_TEXT_MESSAGE_END" },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r1" },
    ];
    agui.addFixture({ match: { message: "think" }, events });
    await agui.start();

    const resp = await post(agui.url, aguiInput("think deeply"));
    expect(resp.status).toBe(200);

    const parsed = parseSSEEvents(resp.body);
    const types = parsed.map((e) => e.type);
    expect(types).toContain("THINKING_TEXT_MESSAGE_START");
    expect(types).toContain("THINKING_TEXT_MESSAGE_CONTENT");
    expect(types).toContain("THINKING_TEXT_MESSAGE_END");
    const thinking = parsed.find(
      (e) => e.type === "THINKING_TEXT_MESSAGE_CONTENT",
    ) as unknown as Record<string, unknown>;
    expect(thinking.delta).toBe("pondering...");
  });

  it("24. CUSTOM and RAW events stream", async () => {
    agui = new AGUIMock({ port: 0 });
    const events: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
      { type: "CUSTOM", name: "my-event", value: { foo: "bar" } },
      { type: "RAW", event: { raw: true }, source: "test" },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r1" },
    ];
    agui.addFixture({ match: { message: "special" }, events });
    await agui.start();

    const resp = await post(agui.url, aguiInput("special events"));
    expect(resp.status).toBe(200);

    const parsed = parseSSEEvents(resp.body);
    const custom = parsed.find((e) => e.type === "CUSTOM") as unknown as Record<string, unknown>;
    expect(custom.name).toBe("my-event");
    expect(custom.value).toEqual({ foo: "bar" });

    const raw = parsed.find((e) => e.type === "RAW") as unknown as Record<string, unknown>;
    expect(raw.event).toEqual({ raw: true });
    expect(raw.source).toBe("test");
  });

  it("25. concurrent SSE streams", async () => {
    agui = new AGUIMock({ port: 0 });
    agui.onMessage("alpha", "Alpha response");
    agui.onMessage("beta", "Beta response");
    await agui.start();

    const [respA, respB] = await Promise.all([
      post(agui.url, aguiInput("alpha request")),
      post(agui.url, aguiInput("beta request")),
    ]);

    expect(respA.status).toBe(200);
    expect(respB.status).toBe(200);

    const eventsA = parseSSEEvents(respA.body);
    const eventsB = parseSSEEvents(respB.body);

    const contentA = eventsA.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as unknown as Record<
      string,
      unknown
    >;
    const contentB = eventsB.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as unknown as Record<
      string,
      unknown
    >;

    expect(contentA.delta).toBe("Alpha response");
    expect(contentB.delta).toBe("Beta response");
  });

  it("26. empty messages array still matches predicates/stateKey", async () => {
    agui = new AGUIMock({ port: 0 });
    agui.onStateKey("mode", { mode: "active" });
    await agui.start();

    const resp = await post(agui.url, {
      messages: [],
      state: { mode: "idle" },
    });
    expect(resp.status).toBe(200);

    const events = parseSSEEvents(resp.body);
    const snap = events.find((e) => e.type === "STATE_SNAPSHOT") as unknown as Record<
      string,
      unknown
    >;
    expect(snap.snapshot).toEqual({ mode: "active" });
  });
});

// ---------------------------------------------------------------------------
// Record & replay (27-32)
// ---------------------------------------------------------------------------

describe("AGUIMock record & replay", () => {
  let upstream: AGUIMock | null = null;
  let tmpDir: string = "";
  let requestCount = 0;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agui-rec-"));
    requestCount = 0;
  });

  afterEach(async () => {
    if (upstream) {
      try {
        await upstream.stop();
      } catch {
        /* already stopped */
      }
      upstream = null;
    }
    // Clean up temp dir
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  /**
   * Start an upstream AGUIMock that counts requests via a predicate fixture.
   */
  async function startUpstreamWithCounter(responseText: string): Promise<string> {
    upstream = new AGUIMock({ port: 0 });
    const events = buildTextResponse(responseText);
    upstream.onPredicate(() => {
      requestCount++;
      return true;
    }, events);
    return upstream.start();
  }

  it("27. proxy-only mode proxies to upstream, does NOT write to disk", async () => {
    const upstreamUrl = await startUpstreamWithCounter("upstream reply");

    agui = new AGUIMock({ port: 0 });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: true, fixturePath: tmpDir });
    await agui.start();

    const resp = await post(agui.url, aguiInput("hello proxy"));
    expect(resp.status).toBe(200);

    const events = parseSSEEvents(resp.body);
    const content = events.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as unknown as Record<
      string,
      unknown
    >;
    expect(content.delta).toBe("upstream reply");

    // Verify no files were written to temp dir
    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(0);
  });

  it("28. record mode proxies, writes fixture, caches in memory", async () => {
    const upstreamUrl = await startUpstreamWithCounter("recorded reply");

    agui = new AGUIMock({ port: 0 });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: false, fixturePath: tmpDir });
    await agui.start();

    const resp = await post(agui.url, aguiInput("hello record"));
    expect(resp.status).toBe(200);

    const events = parseSSEEvents(resp.body);
    const content = events.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as unknown as Record<
      string,
      unknown
    >;
    expect(content.delta).toBe("recorded reply");

    // Verify fixture file was created
    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBeGreaterThan(0);

    // Verify file is valid JSON with fixtures array
    const fileContent = fs.readFileSync(path.join(tmpDir, files[0]), "utf-8");
    const parsed = JSON.parse(fileContent);
    expect(parsed.fixtures).toBeDefined();
    expect(Array.isArray(parsed.fixtures)).toBe(true);
    expect(parsed.fixtures.length).toBe(1);
  });

  it("29. second identical request matches recorded fixture (record mode)", async () => {
    const upstreamUrl = await startUpstreamWithCounter("once only");

    agui = new AGUIMock({ port: 0 });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: false, fixturePath: tmpDir });
    await agui.start();

    // First request — hits upstream
    await post(agui.url, aguiInput("hello cached"));
    expect(requestCount).toBe(1);

    // Second identical request — should match in-memory fixture
    const resp2 = await post(agui.url, aguiInput("hello cached"));
    expect(resp2.status).toBe(200);
    expect(requestCount).toBe(1); // upstream NOT hit again

    const events = parseSSEEvents(resp2.body);
    const content = events.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as unknown as Record<
      string,
      unknown
    >;
    expect(content.delta).toBe("once only");
  });

  it("30. second identical request re-proxies (proxy-only mode)", async () => {
    const upstreamUrl = await startUpstreamWithCounter("always proxy");

    agui = new AGUIMock({ port: 0 });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: true, fixturePath: tmpDir });
    await agui.start();

    // First request
    await post(agui.url, aguiInput("hello again"));
    expect(requestCount).toBe(1);

    // Second identical request — should hit upstream again (no caching)
    await post(agui.url, aguiInput("hello again"));
    expect(requestCount).toBe(2);
  });

  it("31. recorded fixture file format is valid", async () => {
    const upstreamUrl = await startUpstreamWithCounter("format check");

    agui = new AGUIMock({ port: 0 });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: false, fixturePath: tmpDir });
    await agui.start();

    await post(agui.url, aguiInput("validate format"));

    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBe(1);

    const fileContent = fs.readFileSync(path.join(tmpDir, files[0]), "utf-8");
    const parsed = JSON.parse(fileContent);

    // Verify structure: { fixtures: [{ match: { message: ... }, events: [...] }] }
    expect(parsed).toHaveProperty("fixtures");
    expect(parsed.fixtures).toHaveLength(1);

    const fixture = parsed.fixtures[0];
    expect(fixture).toHaveProperty("match");
    expect(fixture.match).toHaveProperty("message");
    expect(fixture.match.message).toBe("validate format");

    expect(fixture).toHaveProperty("events");
    expect(Array.isArray(fixture.events)).toBe(true);
    expect(fixture.events.length).toBeGreaterThan(0);

    // Verify events contain expected AG-UI types
    const types = fixture.events.map((e: AGUIEvent) => e.type);
    expect(types).toContain("RUN_STARTED");
    expect(types).toContain("RUN_FINISHED");
    expect(types).toContain("TEXT_MESSAGE_CONTENT");
  });

  it("32. client receives real-time stream during recording", async () => {
    const upstreamUrl = await startUpstreamWithCounter("streamed");

    agui = new AGUIMock({ port: 0 });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: false, fixturePath: tmpDir });
    await agui.start();

    const resp = await post(agui.url, aguiInput("stream check"));
    expect(resp.status).toBe(200);
    expect(resp.headers["content-type"]).toBe("text/event-stream");

    // Verify proper SSE format — body should contain "data: " lines separated by double newlines
    expect(resp.body).toContain("data: ");
    expect(resp.body).toContain("\n\n");

    // Verify we can parse all events from the stream
    const events = parseSSEEvents(resp.body);
    expect(events.length).toBeGreaterThan(0);

    const types = events.map((e) => e.type);
    expect(types).toContain("RUN_STARTED");
    expect(types).toContain("TEXT_MESSAGE_CONTENT");
    expect(types).toContain("RUN_FINISHED");
  });

  // ---- Continuation (HITL) recording tests (46-48) ----

  it("46. continuation recording writes toolCallId fixture", async () => {
    const upstreamUrl = await startUpstreamWithCounter("continuation reply");

    agui = new AGUIMock({ port: 0 });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: false, fixturePath: tmpDir });
    await agui.start();

    const resp = await post(agui.url, {
      messages: [{ id: "m1", role: "tool", toolCallId: "call_hitl_001", content: "approved" }],
      threadId: "t1",
    });
    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBe(1);

    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), "utf-8"));
    expect(parsed.fixtures).toHaveLength(1);
    expect(parsed.fixtures[0].match.toolCallId).toBe("call_hitl_001");
    expect(parsed.fixtures[0].match.message).toBeUndefined();
  });

  it("47. continuation replay from recorded fixture", async () => {
    const upstreamUrl = await startUpstreamWithCounter("replay me");

    agui = new AGUIMock({ port: 0 });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: false, fixturePath: tmpDir });
    await agui.start();

    // First request — hits upstream
    await post(agui.url, {
      messages: [{ id: "m1", role: "tool", toolCallId: "call_hitl_001", content: "approved" }],
      threadId: "t1",
    });
    expect(requestCount).toBe(1);

    // Second identical request — should match in-memory fixture
    const resp2 = await post(agui.url, {
      messages: [{ id: "m1", role: "tool", toolCallId: "call_hitl_001", content: "approved" }],
      threadId: "t1",
    });
    expect(resp2.status).toBe(200);
    expect(requestCount).toBe(1); // upstream NOT hit again

    const events = parseSSEEvents(resp2.body);
    const content = events.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as unknown as Record<
      string,
      unknown
    >;
    expect(content.delta).toBe("replay me");
  });

  it("48. normal request still records message fixture", async () => {
    const upstreamUrl = await startUpstreamWithCounter("normal reply");

    agui = new AGUIMock({ port: 0 });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: false, fixturePath: tmpDir });
    await agui.start();

    const resp = await post(agui.url, aguiInput("normal user message"));
    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBe(1);

    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), "utf-8"));
    expect(parsed.fixtures).toHaveLength(1);
    expect(parsed.fixtures[0].match.message).toBe("normal user message");
    expect(parsed.fixtures[0].match.toolCallId).toBeUndefined();
  });

  it("49. fallback predicate fixture is in-memory only (no disk write)", async () => {
    const upstreamUrl = await startUpstreamWithCounter("sentinel reply");

    agui = new AGUIMock({ port: 0 });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: false, fixturePath: tmpDir });
    await agui.start();

    const resp = await post(agui.url, {
      messages: [{ id: "m1", role: "tool", content: "no-id" }],
      threadId: "t1",
    });
    expect(resp.status).toBe(200);

    // Predicate fixtures should NOT be written to disk — the sentinel
    // string becomes a literal match that never matches real requests
    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBe(0);

    // But the fixture IS available in memory for same-session replay
    const resp2 = await post(agui.url, {
      messages: [{ id: "m2", role: "tool", content: "another-no-id" }],
      threadId: "t2",
    });
    expect(resp2.status).toBe(200);
  });

  // ---- Recorder priority test (50) ----

  it("50. tool result wins over user message in history", async () => {
    const upstreamUrl = await startUpstreamWithCounter("priority reply");

    agui = new AGUIMock({ port: 0 });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: false, fixturePath: tmpDir });
    await agui.start();

    const resp = await post(agui.url, {
      messages: [
        { id: "m1", role: "user", content: "approve the action" },
        { id: "m2", role: "tool", toolCallId: "call_789", content: "result" },
      ],
      threadId: "t1",
    });
    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBe(1);

    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), "utf-8"));
    expect(parsed.fixtures).toHaveLength(1);
    expect(parsed.fixtures[0].match.toolCallId).toBe("call_789");
    expect(parsed.fixtures[0].match.message).toBeUndefined();
  });

  // ---- Full HITL round-trip integration test (51) ----

  it("51. full round-trip: record two legs then replay without upstream", async () => {
    // Build upstream with two fixtures routed by predicate.
    // Continuation (leg 2) must be checked FIRST because leg 2 requests
    // also contain the original user message in history.
    upstream = new AGUIMock({ port: 0 });
    const leg1Events = buildToolCallResponse("confirm_action", '{"action":"delete"}');
    const leg2Events = buildTextResponse("Action confirmed");

    // Leg 2: continuation — last message is tool result with toolCallId
    upstream.onPredicate((input) => {
      const msgs = input.messages ?? [];
      const last = msgs[msgs.length - 1];
      if (last?.role === "tool" && last?.toolCallId === "call_rt_001") {
        requestCount++;
        return true;
      }
      return false;
    }, leg2Events);

    // Leg 1: initial user message (only matches when last message is NOT a tool result)
    upstream.onPredicate((input) => {
      const msgs = input.messages ?? [];
      const last = msgs[msgs.length - 1];
      if (last?.role === "user") {
        requestCount++;
        return true;
      }
      return false;
    }, leg1Events);

    const upstreamUrl = await upstream.start();

    // Create recording proxy
    agui = new AGUIMock({ port: 0 });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: false, fixturePath: tmpDir });
    await agui.start();

    // RECORD PHASE — Leg 1: user message
    const resp1 = await post(agui.url, {
      messages: [{ id: "m1", role: "user", content: "What should I do?" }],
      threadId: "t-rt",
    });
    expect(resp1.status).toBe(200);
    const events1 = parseSSEEvents(resp1.body);
    const types1 = events1.map((e) => e.type);
    expect(types1).toContain("TOOL_CALL_START");
    expect(types1).toContain("TOOL_CALL_ARGS");

    // RECORD PHASE — Leg 2: continuation with tool result
    // Note: only tool result in messages (no user message) so it doesn't
    // match the leg 1 fixture keyed on user message content.
    const resp2 = await post(agui.url, {
      messages: [{ id: "m2", role: "tool", toolCallId: "call_rt_001", content: "confirmed" }],
      threadId: "t-rt",
    });
    expect(resp2.status).toBe(200);
    const events2 = parseSSEEvents(resp2.body);
    const content2 = events2.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as unknown as Record<
      string,
      unknown
    >;
    expect(content2.delta).toBe("Action confirmed");

    // Verify 2 fixture files on disk: one with match.message, one with match.toolCallId
    const files = fs.readdirSync(tmpDir).sort();
    expect(files.length).toBe(2);

    const fixtures = files.map((f) => JSON.parse(fs.readFileSync(path.join(tmpDir, f), "utf-8")));
    const matchTypes = fixtures.map((f) => f.fixtures[0].match);
    const hasMessage = matchTypes.some(
      (m: Record<string, unknown>) => m.message !== undefined && m.toolCallId === undefined,
    );
    const hasToolCallId = matchTypes.some(
      (m: Record<string, unknown>) => m.toolCallId !== undefined,
    );
    expect(hasMessage).toBe(true);
    expect(hasToolCallId).toBe(true);

    // Track how many times upstream was hit during recording
    const recordingHits = requestCount;

    // REPLAY PHASE — Stop upstream
    await upstream.stop();
    upstream = null;

    // Replay leg 1
    const replay1 = await post(agui.url, {
      messages: [{ id: "m1", role: "user", content: "What should I do?" }],
      threadId: "t-rt",
    });
    expect(replay1.status).toBe(200);
    const replayEvents1 = parseSSEEvents(replay1.body);
    const replayTypes1 = replayEvents1.map((e) => e.type);
    expect(replayTypes1).toContain("TOOL_CALL_START");

    // Replay leg 2
    const replay2 = await post(agui.url, {
      messages: [{ id: "m2", role: "tool", toolCallId: "call_rt_001", content: "confirmed" }],
      threadId: "t-rt",
    });
    expect(replay2.status).toBe(200);
    const replayEvents2 = parseSSEEvents(replay2.body);
    const replayContent2 = replayEvents2.find(
      (e) => e.type === "TEXT_MESSAGE_CONTENT",
    ) as unknown as Record<string, unknown>;
    expect(replayContent2.delta).toBe("Action confirmed");

    // Upstream was hit exactly twice during recording, zero during replay
    expect(requestCount).toBe(recordingHits);
  });
});

// ---------------------------------------------------------------------------
// getLastMessageIfToolResult unit tests (33-35)
// ---------------------------------------------------------------------------

describe("getLastMessageIfToolResult", () => {
  it("33. returns the tool message when last message has role tool with toolCallId", () => {
    const input: AGUIRunAgentInput = {
      threadId: "t1",
      runId: "r1",
      messages: [
        { id: "m1", role: "user", content: "do something" },
        { id: "m2", role: "tool", toolCallId: "call_abc", content: "approved" },
      ],
    };
    const result = getLastMessageIfToolResult(input);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("m2");
    expect(result!.role).toBe("tool");
    expect(result!.toolCallId).toBe("call_abc");
  });

  it("34. returns null when last message is not role tool", () => {
    const input: AGUIRunAgentInput = {
      threadId: "t1",
      runId: "r1",
      messages: [
        { id: "m1", role: "tool", toolCallId: "call_abc", content: "result" },
        { id: "m2", role: "user", content: "follow up" },
      ],
    };
    const result = getLastMessageIfToolResult(input);
    expect(result).toBeNull();
  });

  it("35. returns null for empty/undefined messages array", () => {
    expect(getLastMessageIfToolResult({ threadId: "t1", runId: "r1", messages: [] })).toBeNull();
    expect(
      getLastMessageIfToolResult({ threadId: "t1", runId: "r1" } as AGUIRunAgentInput),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchesFixture toolCallId unit tests (36-41)
// ---------------------------------------------------------------------------

describe("matchesFixture toolCallId", () => {
  it("36. toolCallId matches when last message is role tool with matching toolCallId", () => {
    const input: AGUIRunAgentInput = {
      threadId: "t1",
      runId: "r1",
      messages: [
        { id: "m1", role: "user", content: "hello" },
        { id: "m2", role: "tool", toolCallId: "call_xyz", content: "done" },
      ],
    };
    expect(matchesFixture(input, { toolCallId: "call_xyz" })).toBe(true);
  });

  it("37. toolCallId does not match wrong ID", () => {
    const input: AGUIRunAgentInput = {
      threadId: "t1",
      runId: "r1",
      messages: [{ id: "m1", role: "tool", toolCallId: "call_xyz", content: "done" }],
    };
    expect(matchesFixture(input, { toolCallId: "call_wrong" })).toBe(false);
  });

  it("38. toolCallId does not match when last message is not role tool", () => {
    const input: AGUIRunAgentInput = {
      threadId: "t1",
      runId: "r1",
      messages: [
        { id: "m1", role: "tool", toolCallId: "call_xyz", content: "done" },
        { id: "m2", role: "user", content: "follow up" },
      ],
    };
    expect(matchesFixture(input, { toolCallId: "call_xyz" })).toBe(false);
  });

  it("39. toolCallId does not match when toolCallId absent on message", () => {
    const input: AGUIRunAgentInput = {
      threadId: "t1",
      runId: "r1",
      messages: [{ id: "m1", role: "tool", content: "no toolCallId" }],
    };
    expect(matchesFixture(input, { toolCallId: "call_xyz" })).toBe(false);
  });

  it("40. AND logic — fixture with both message and toolCallId must both match", () => {
    const inputBothMatch: AGUIRunAgentInput = {
      threadId: "t1",
      runId: "r1",
      messages: [
        { id: "m1", role: "user", content: "approve this" },
        { id: "m2", role: "tool", toolCallId: "call_abc", content: "approved" },
      ],
    };
    // Both criteria match
    expect(matchesFixture(inputBothMatch, { message: "approve", toolCallId: "call_abc" })).toBe(
      true,
    );

    // Message matches but toolCallId does not
    expect(matchesFixture(inputBothMatch, { message: "approve", toolCallId: "call_wrong" })).toBe(
      false,
    );

    // toolCallId matches but message does not
    expect(matchesFixture(inputBothMatch, { message: "reject", toolCallId: "call_abc" })).toBe(
      false,
    );
  });

  it("41. AND logic — fixture with both toolCallId and stateKey must both match", () => {
    const inputBothMatch: AGUIRunAgentInput = {
      threadId: "t1",
      runId: "r1",
      messages: [{ id: "m1", role: "tool", toolCallId: "call_state", content: "result" }],
      state: { counter: 10 },
    };
    // Both criteria match
    expect(matchesFixture(inputBothMatch, { toolCallId: "call_state", stateKey: "counter" })).toBe(
      true,
    );

    // toolCallId matches but stateKey does not
    expect(matchesFixture(inputBothMatch, { toolCallId: "call_state", stateKey: "missing" })).toBe(
      false,
    );

    // stateKey matches but toolCallId does not
    expect(matchesFixture(inputBothMatch, { toolCallId: "call_wrong", stateKey: "counter" })).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// onToolResult fluent API tests (42-43)
// ---------------------------------------------------------------------------

describe("onToolResult fluent API", () => {
  it("42. onToolResult registers fixture and matching request returns 200", async () => {
    agui = new AGUIMock({ port: 0 });
    agui.onToolResult("call_abc", buildTextResponse("continuation response"));
    await agui.start();

    const resp = await post(agui.url, {
      messages: [{ id: "m1", role: "tool", toolCallId: "call_abc", content: "approved" }],
      threadId: "test",
    });
    expect(resp.status).toBe(200);

    const events = parseSSEEvents(resp.body);
    const content = events.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as unknown as Record<
      string,
      unknown
    >;
    expect(content).toBeDefined();
    expect(content.delta).toBe("continuation response");
  });

  it("43. onToolResult with delayMs applies delay", async () => {
    agui = new AGUIMock({ port: 0 });
    agui.onToolResult("call_delayed", buildTextResponse("delayed continuation"), 50);
    await agui.start();

    const start = Date.now();
    const resp = await post(agui.url, {
      messages: [{ id: "m1", role: "tool", toolCallId: "call_delayed", content: "result" }],
      threadId: "test",
    });
    const elapsed = Date.now() - start;

    expect(resp.status).toBe(200);
    // 5 events * 50ms = 250ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// Config loader toolCallId pass-through tests (44-45)
// ---------------------------------------------------------------------------

describe("config loader toolCallId pass-through", () => {
  it("44. addFixture with toolCallId match returns 200 for matching tool message", async () => {
    agui = new AGUIMock({ port: 0 });
    agui.addFixture({
      match: { toolCallId: "call_config_123" },
      events: buildTextResponse("config response"),
    });
    await agui.start();

    const resp = await post(agui.url, {
      messages: [{ id: "m1", role: "tool", toolCallId: "call_config_123", content: "tool output" }],
      threadId: "test",
    });
    expect(resp.status).toBe(200);

    const events = parseSSEEvents(resp.body);
    const content = events.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as unknown as Record<
      string,
      unknown
    >;
    expect(content).toBeDefined();
    expect(content.delta).toBe("config response");
  });

  it("45. same fixture returns 404 for user message instead of tool result", async () => {
    agui = new AGUIMock({ port: 0 });
    agui.addFixture({
      match: { toolCallId: "call_config_123" },
      events: buildTextResponse("config response"),
    });
    await agui.start();

    const resp = await post(agui.url, {
      messages: [{ id: "m1", role: "user", content: "hello" }],
      threadId: "test",
    });
    expect(resp.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// extractLastUserMessage — string and structured content
// ---------------------------------------------------------------------------

describe("extractLastUserMessage", () => {
  it("returns plain string content verbatim", () => {
    expect(
      extractLastUserMessage({
        messages: [{ id: "1", role: "user", content: "hello" }],
      }),
    ).toBe("hello");
  });

  it("returns text from a single-part array", () => {
    expect(
      extractLastUserMessage({
        messages: [{ id: "1", role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    ).toBe("hello");
  });

  it("joins multiple text parts with a single space", () => {
    expect(
      extractLastUserMessage({
        messages: [
          {
            id: "1",
            role: "user",
            content: [
              { type: "text", text: "part one" },
              { type: "text", text: "part two" },
            ],
          },
        ],
      }),
    ).toBe("part one part two");
  });

  it("extracts only text parts when mixed with non-text parts (e.g. file attachments)", () => {
    expect(
      extractLastUserMessage({
        messages: [
          {
            id: "1",
            role: "user",
            content: [
              { type: "text", text: "summarize this" },
              {
                type: "document",
                source: { type: "data", value: "AAA=", mimeType: "text/plain" },
              },
            ],
          },
        ],
      }),
    ).toBe("summarize this");
  });

  it("returns empty string when content has no text parts", () => {
    expect(
      extractLastUserMessage({
        messages: [
          {
            id: "1",
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "data", value: "AAA=", mimeType: "text/plain" },
              },
            ],
          },
        ],
      }),
    ).toBe("");
  });

  it("ignores non-text parts that happen to carry a 'text' field", () => {
    expect(
      extractLastUserMessage({
        messages: [
          {
            id: "1",
            role: "user",
            content: [{ type: "image", text: "alt text not part of the message" }],
          },
        ],
      }),
    ).toBe("");
  });

  it("returns the last user turn's text when multiple user turns exist", () => {
    expect(
      extractLastUserMessage({
        messages: [
          { id: "1", role: "user", content: "first" },
          { id: "2", role: "assistant", content: "ack" },
          { id: "3", role: "user", content: [{ type: "text", text: "second" }] },
        ],
      }),
    ).toBe("second");
  });

  it("skips non-user roles even when they have text content", () => {
    expect(
      extractLastUserMessage({
        messages: [
          { id: "1", role: "user", content: "real user message" },
          { id: "2", role: "assistant", content: "assistant turn" },
        ],
      }),
    ).toBe("real user message");
  });

  it("returns empty string for empty or missing messages", () => {
    expect(extractLastUserMessage({ messages: [] })).toBe("");
    expect(extractLastUserMessage({} as AGUIRunAgentInput)).toBe("");
  });

  it("returns empty string when user message content is undefined", () => {
    expect(
      extractLastUserMessage({
        messages: [{ id: "1", role: "user" }],
      }),
    ).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Recorder regression — structured user content produces a matchable fixture
// ---------------------------------------------------------------------------

describe("AGUIMock recorder — structured user content", () => {
  let upstream: AGUIMock | null = null;
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agui-structured-"));
  });

  afterEach(async () => {
    if (upstream) {
      try {
        await upstream.stop();
      } catch {
        /* already stopped */
      }
      upstream = null;
    }
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("writes match.message from text parts, not the sentinel, when content is structured", async () => {
    upstream = new AGUIMock({ port: 0 });
    upstream.onPredicate(() => true, buildTextResponse("ok"));
    const upstreamUrl = await upstream.start();

    agui = new AGUIMock({ port: 0 });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: false, fixturePath: tmpDir });
    await agui.start();

    const resp = await post(agui.url, {
      messages: [
        {
          id: "u1",
          role: "user",
          content: [
            { type: "text", text: "summarize this" },
            {
              type: "document",
              source: { type: "data", value: "AAA=", mimeType: "text/plain" },
            },
          ],
        },
      ],
    } as AGUIRunAgentInput);
    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBe(1);
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), "utf-8"));
    expect(parsed.fixtures[0].match.message).toBe("summarize this");
    expect(parsed.fixtures[0].match.message).not.toBe(NO_USER_MESSAGE_SENTINEL);
  });

  it("skips disk write for no-user-text predicate fixtures (in-memory only)", async () => {
    upstream = new AGUIMock({ port: 0 });
    upstream.onPredicate(() => true, buildTextResponse("ok"));
    const upstreamUrl = await upstream.start();

    agui = new AGUIMock({ port: 0 });
    agui.enableRecording({ upstream: upstreamUrl, proxyOnly: false, fixturePath: tmpDir });
    await agui.start();

    const resp = await post(agui.url, {
      messages: [
        {
          id: "u1",
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "data", value: "AAA=", mimeType: "text/plain" },
            },
          ],
        },
      ],
    } as AGUIRunAgentInput);
    expect(resp.status).toBe(200);

    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBe(0);

    const resp2 = await post(agui.url, {
      messages: [
        {
          id: "u2",
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "data", value: "BBB=", mimeType: "text/plain" },
            },
          ],
        },
      ],
    } as AGUIRunAgentInput);
    expect(resp2.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// NO_USER_MESSAGE_SENTINEL — wire-format compatibility guard
// ---------------------------------------------------------------------------

describe("NO_USER_MESSAGE_SENTINEL", () => {
  it("preserves the historical on-disk sentinel string", () => {
    // Locking the literal value: existing recorded fixtures on disk use this
    // exact string and must continue to round-trip without churn.
    expect(NO_USER_MESSAGE_SENTINEL).toBe("__NO_USER_MESSAGE__");
  });
});
