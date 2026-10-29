import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { A2AMock } from "../a2a-mock.js";
import { LLMock } from "../llmock.js";
import { loadConfig, startFromConfig } from "../config-loader.js";
import type { AimockConfig } from "../config-loader.js";
import type {
  A2AConversationOptions,
  A2AConversationTurn,
  A2APart,
  A2ATask,
} from "../a2a-types.js";

type Wire = {
  jsonrpc: string;
  id: string | number;
  result?: { task?: A2ATask; tasks?: A2ATask[]; message?: { parts: A2APart[] } };
  error?: { code: number; message: string };
};
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const INPUT = "TASK_STATE_INPUT_REQUIRED";
const DONE = "TASK_STATE_COMPLETED";
const FAILED = "TASK_STATE_FAILED";
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

function turn(pattern: string | RegExp, state = INPUT, text = "reply"): A2AConversationTurn {
  return {
    pattern,
    response: {
      state: state as A2AConversationTurn["response"]["state"],
      parts: [{ text }],
      artifacts: [{ name: text, parts: [{ data: { text, flags: [false, null, 0] } }] }],
    },
  };
}
function script(): A2AConversationTurn[] {
  return [
    turn("start", INPUT, "question"),
    turn("answer", INPUT, "confirmation"),
    turn("finish", DONE, "result"),
  ];
}
function register(mock: A2AMock, turns = script(), name = "agent"): void {
  mock.onConversation(name, turns);
}
async function fixture(turns = script(), mounted = false, options?: A2AConversationOptions) {
  const mock = new A2AMock().registerAgent({ name: "agent" });
  mock.onConversation("agent", turns, options);
  if (mounted) {
    const llm = new LLMock();
    llm.mount("/nested/a2a", mock);
    await llm.start();
    stops.push(() => llm.stop());
    return { mock, url: llm.url + "/nested/a2a" };
  }
  const url = await mock.start();
  stops.push(() => mock.stop());
  return { mock, url };
}
async function post(url: string, body: unknown): Promise<{ type: string; data: string }> {
  return new Promise((resolveResponse, reject) => {
    const request = http.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolveResponse({
            type: String(response.headers["content-type"] ?? ""),
            data: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}
function envelopes(raw: { type: string; data: string }): Wire[] {
  if (!raw.type.startsWith("text/event-stream")) return [JSON.parse(raw.data) as Wire];
  return raw.data
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .flatMap((event) => {
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      return data && data !== "[DONE]" ? [JSON.parse(data) as Wire] : [];
    });
}
async function rpc(url: string, method: string, params: unknown): Promise<Wire> {
  const raw = await post(url, { jsonrpc: "2.0", id: "call", method, params });
  return envelopes(raw).at(-1)!;
}
function message(text: string, extra: Record<string, unknown> = {}) {
  return { role: "ROLE_USER", messageId: `user:${text}`, parts: [{ text }], ...extra };
}
async function send(
  url: string,
  text: string,
  extra: Record<string, unknown> = {},
  streaming = false,
): Promise<A2ATask> {
  const raw = await post(url, {
    jsonrpc: "2.0",
    id: "send",
    method: streaming ? "SendStreamingMessage" : "SendMessage",
    params: { message: message(text, extra) },
  });
  if (streaming) expect(raw.type).toMatch(/^text\/event-stream(?:;|$)/);
  const received = envelopes(raw);
  expect(received.length).toBeGreaterThan(0);
  const last = received.at(-1)!;
  expect(last, raw.data).toMatchObject({ jsonrpc: "2.0", id: "send" });
  expect(last.error, raw.data).toBeUndefined();
  expect(last.result?.task, raw.data).toBeDefined();
  return last.result!.task!;
}
async function getTask(url: string, id: string): Promise<A2ATask> {
  const result = await rpc(url, "GetTask", { id });
  expect(result.error).toBeUndefined();
  return result.result!.task!;
}
async function list(url: string, params: Record<string, unknown> = {}): Promise<A2ATask[]> {
  const result = await rpc(url, "ListTasks", params);
  expect(result.error).toBeUndefined();
  return result.result!.tasks!;
}
async function rejected(
  url: string,
  code: number,
  text: string,
  extra: Record<string, unknown>,
  streaming = false,
): Promise<void> {
  const result = await rpc(url, streaming ? "SendStreamingMessage" : "SendMessage", {
    message: message(text, extra),
  });
  expect(result.error).toMatchObject({ code, message: expect.any(String) });
  expect(result.result).toBeUndefined();
}

describe("bounded conversation retries", () => {
  const repeated = (count = 6) =>
    Array.from({ length: count }, (_, index) =>
      turn("", index === count - 1 ? DONE : INPUT, `reply-${index}`),
    );

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "2", null, true])(
    "rejects invalid replayLimit %s atomically",
    async (replayLimit) => {
      const mock = new A2AMock().registerAgent({ name: "agent" });
      mock.onConversation("agent", [turn("existing", DONE, "kept")]);
      expect(() =>
        mock.onConversation("agent", [turn("new", DONE, "discarded")], {
          replayLimit: replayLimit as number,
        }),
      ).toThrow();
      mock.onConversation("agent", [turn("new", DONE, "replacement")], { replayLimit: 1 });
      const url = await mock.start();
      stops.push(() => mock.stop());
      expect((await send(url, "existing")).history[1].parts).toEqual([{ text: "kept" }]);
      expect((await send(url, "new")).history[1].parts).toEqual([{ text: "replacement" }]);
    },
  );

  it("accepts the inclusive maximum without allocating the whole allowance", async () => {
    const { url } = await fixture([turn("start", DONE)], false, {
      replayLimit: Number.MAX_SAFE_INTEGER,
    });
    const first = await send(url, "start");
    expect(await send(url, "start", { taskId: first.id })).toEqual(first);
  });

  it.each([undefined, 0])("disables replay at limit %s", async (replayLimit) => {
    const { url } = await fixture(repeated(3), false, { replayLimit });
    const first = await send(url, "same", { messageId: "same" });
    const next = await send(url, "same", { messageId: "same", taskId: first.id });
    expect(next.history).toHaveLength(4);
    expect(next.history[3].parts).toEqual([{ text: "reply-1" }]);
  });

  it.each([false, true])(
    "replays the original snapshot across transports and envelope IDs, mounted=%s",
    async (mounted) => {
      const { url } = await fixture(script(), mounted, { replayLimit: 3 });
      const first = await send(url, "start", { messageId: "first", contextId: "shared" }, mounted);
      const next = await send(url, "answer", { messageId: "second", taskId: first.id }, !mounted);
      for (const streaming of [false, true]) {
        const raw = await post(url, {
          jsonrpc: "2.0",
          id: "new-envelope",
          method: streaming ? "SendStreamingMessage" : "SendMessage",
          params: { message: message("start", { messageId: "first", taskId: first.id }) },
        });
        if (streaming) expect(raw.type).toMatch(/^text\/event-stream(?:;|$)/);
        expect(envelopes(raw).at(-1)).toEqual({
          jsonrpc: "2.0",
          id: "new-envelope",
          result: { task: first },
        });
        expect(await getTask(url, first.id)).toEqual(next);
        expect(await list(url)).toEqual([next]);
      }
      const final = await send(url, "finish", { taskId: first.id, messageId: "third" });
      expect(final.history).toHaveLength(6);
      expect(final.artifacts).toHaveLength(3);
    },
  );

  it("compares all JSON parts independent of object insertion order", async () => {
    const { url } = await fixture(repeated(), false, { replayLimit: 2 });
    const parts = [
      { text: "same" },
      {
        data: { z: [1, { a: false, b: null }], a: { p: "x", q: 3 } },
        mediaType: "application/json",
      },
      { url: "https://example.test/file", mediaType: "image/png" },
    ];
    const reordered = [
      { text: "same" },
      {
        mediaType: "application/json",
        data: { a: { q: 3, p: "x" }, z: [1, { b: null, a: false }] },
      },
      { mediaType: "image/png", url: "https://example.test/file" },
    ];
    const first = await send(url, "", { messageId: "__proto__", parts });
    expect(
      await send(url, "", { messageId: "__proto__", parts: reordered, taskId: first.id }, true),
    ).toEqual(first);
    expect(await getTask(url, first.id)).toEqual(first);
  });

  const originalParts = [
    { text: "same" },
    { data: { nested: [1, 2], value: false }, mediaType: "application/json" },
    { url: "https://example.test/a", mediaType: "image/png" },
  ];
  it.each([
    [
      "nested scalar",
      [
        { text: "same" },
        { data: { nested: [1, 2], value: 0 }, mediaType: "application/json" },
        originalParts[2],
      ],
    ],
    [
      "nested array order",
      [
        { text: "same" },
        { data: { nested: [2, 1], value: false }, mediaType: "application/json" },
        originalParts[2],
      ],
    ],
    ["part order", [originalParts[1], originalParts[0], originalParts[2]]],
    ["text", [{ text: "different" }, originalParts[1], originalParts[2]]],
    [
      "URL",
      [
        originalParts[0],
        originalParts[1],
        { url: "https://example.test/b", mediaType: "image/png" },
      ],
    ],
    [
      "media type",
      [
        originalParts[0],
        originalParts[1],
        { url: "https://example.test/a", mediaType: "image/jpeg" },
      ],
    ],
  ])("rejects changed %s without accepting a matching next turn", async (_name, changed) => {
    const { url } = await fixture(repeated(), false, { replayLimit: 1 });
    const first = await send(url, "", { messageId: "kept", parts: originalParts });
    await rejected(url, -32602, "", { taskId: first.id, messageId: "kept", parts: changed }, true);
    expect(await getTask(url, first.id)).toEqual(first);
    expect(await list(url)).toEqual([first]);
    expect(
      await send(url, "", { taskId: first.id, messageId: "kept", parts: originalParts }),
    ).toEqual(first);
    const next = await send(url, "", { taskId: first.id, messageId: "fresh", parts: changed });
    expect(next.history).toHaveLength(4);
    expect(next.history[3].parts).toEqual([{ text: "reply-1" }]);
  });

  it("evicts only beyond the bound in acceptance order and treats evicted IDs as unseen", async () => {
    const { url } = await fixture(repeated(), false, { replayLimit: 2 });
    const first = await send(url, "one", { messageId: "a" });
    const second = await send(url, "two", { taskId: first.id, messageId: "b" });
    expect(await send(url, "one", { taskId: first.id, messageId: "a" })).toEqual(first);
    const third = await send(url, "three", { taskId: first.id, messageId: "c" });
    expect(await send(url, "two", { taskId: first.id, messageId: "b" })).toEqual(second);
    const reused = await send(url, "different content", { taskId: first.id, messageId: "a" });
    expect(reused.history).toHaveLength(8);
    expect(reused.history[7].parts).toEqual([{ text: "reply-3" }]);
    expect(await send(url, "three", { taskId: first.id, messageId: "c" })).toEqual(third);
    expect(await getTask(url, first.id)).toEqual(reused);
  });

  it("keeps records across rejected new IDs, conflicts, and invalid contexts", async () => {
    const { url } = await fixture(script(), false, { replayLimit: 1 });
    const first = await send(url, "start", { messageId: "kept", contextId: "ctx" });
    await rejected(url, -32602, "answer", { taskId: first.id, messageId: "kept" });
    await rejected(url, -32000, "wrong", { taskId: first.id, messageId: "new" });
    await rejected(url, -32602, "start", {
      taskId: first.id,
      messageId: "kept",
      contextId: "other",
    });
    await rejected(url, -32001, "start", { taskId: "unknown", messageId: "kept" });
    expect(await send(url, "start", { taskId: first.id, messageId: "kept" })).toEqual(first);
    const second = await send(url, "answer", { taskId: first.id, messageId: "new" });
    expect(second.history).toHaveLength(4);
    await rejected(url, -32000, "start", { taskId: first.id, messageId: "kept" });
    expect(await getTask(url, first.id)).toEqual(second);
  });

  it.each([undefined, ""])(
    "unkeyed sends with ID %s do not consume or evict retention",
    async (messageId) => {
      const { url } = await fixture(repeated(), false, { replayLimit: 1 });
      const first = await send(url, "one", { messageId: "kept" });
      const second = await send(url, "two", { taskId: first.id, messageId });
      const third = await send(url, "two", { taskId: first.id, messageId });
      expect(second.history).toHaveLength(4);
      expect(third.history).toHaveLength(6);
      expect(await send(url, "one", { taskId: first.id, messageId: "kept" })).toEqual(first);
      expect(await getTask(url, first.id)).toEqual(third);
    },
  );

  it.each([DONE, FAILED, "TASK_STATE_CANCELED"])(
    "replays retained snapshots after %s without reviving the task",
    async (state) => {
      const { url } = await fixture(
        [turn("start", INPUT), turn("end", state === FAILED ? FAILED : DONE)],
        false,
        { replayLimit: 2 },
      );
      const first = await send(url, "start", { messageId: "first" });
      let terminal: A2ATask;
      if (state === "TASK_STATE_CANCELED") {
        terminal = (await rpc(url, "CancelTask", { id: first.id })).result!.task!;
      } else {
        terminal = await send(url, "end", { taskId: first.id, messageId: "last" });
        expect(await send(url, "end", { taskId: first.id, messageId: "last" }, true)).toEqual(
          terminal,
        );
      }
      expect(terminal.status.state).toBe(state);
      expect(await send(url, "start", { taskId: first.id, messageId: "first" }, true)).toEqual(
        first,
      );
      await rejected(url, -32004, "end", { taskId: first.id, messageId: "unseen" });
      await rejected(url, -32602, "start", {
        taskId: first.id,
        messageId: "first",
        contextId: "wrong",
      });
      expect(await getTask(url, first.id)).toEqual(terminal);
      expect(await list(url)).toEqual([terminal]);
    },
  );

  it("isolates IDs and retention between tasks, contexts, fixtures, and mock instances", async () => {
    const { mock, url } = await fixture(repeated(), false, { replayLimit: 1 });
    const other = await fixture(repeated(), false, { replayLimit: 3 });
    const first = await send(url, "same", { messageId: "shared", contextId: "shared" });
    const second = await send(url, "same", { messageId: "shared", contextId: "shared" });
    const separate = await send(other.url, "same", { messageId: "shared", contextId: "shared" });
    expect(first.id).not.toBe(second.id);
    mock.onConversation("agent", repeated(), { replayLimit: 0 });
    const advanced = await send(url, "next", { taskId: first.id, messageId: "next" });
    expect(await send(url, "same", { taskId: second.id, messageId: "shared" })).toEqual(second);
    expect(await send(other.url, "same", { taskId: separate.id, messageId: "shared" })).toEqual(
      separate,
    );
    expect(await send(url, "next", { taskId: first.id, messageId: "next" })).toEqual(advanced);
    expect(await list(url)).toHaveLength(2);
    expect(await list(other.url)).toEqual([separate]);
  });

  it("uses each selected fixture's limit", async () => {
    const mock = new A2AMock().registerAgent({ name: "agent" });
    mock.onConversation("agent", [turn("one", INPUT), turn("next", INPUT), turn("end", DONE)], {
      replayLimit: 1,
    });
    mock.onConversation("agent", [turn("two", INPUT), turn("next", INPUT), turn("end", DONE)], {
      replayLimit: 2,
    });
    const url = await mock.start();
    stops.push(() => mock.stop());
    const one = await send(url, "one", { messageId: "first" });
    const two = await send(url, "two", { messageId: "first" });
    await send(url, "next", { taskId: one.id, messageId: "second" });
    await send(url, "next", { taskId: two.id, messageId: "second" });
    await rejected(url, -32000, "one", { taskId: one.id, messageId: "first" });
    expect(await send(url, "two", { taskId: two.id, messageId: "first" })).toEqual(two);
  });

  it("accepts one turn for overlapping identical requests regardless of arrival order", async () => {
    const { url } = await fixture(repeated(), false, { replayLimit: 2 });
    const first = await send(url, "start", { messageId: "first" });
    const responses = await Promise.all(
      [false, true, false, true].map((streaming) =>
        send(url, "next", { taskId: first.id, messageId: "same" }, streaming),
      ),
    );
    for (const response of responses) expect(response).toEqual(responses[0]);
    expect(responses[0].history).toHaveLength(4);
    expect(responses[0].artifacts).toHaveLength(2);
    expect(await getTask(url, first.id)).toEqual(responses[0]);
  });

  it.each([0, 2])(
    "loads replayLimit %s through JSON configuration and mounted streaming",
    async (replayLimit) => {
      const directory = mkdtempSync(join(tmpdir(), "a2a-retry-4540d5-"));
      try {
        const filename = join(directory, "config.json");
        writeFileSync(
          filename,
          JSON.stringify({
            a2a: {
              path: "/retry",
              agents: [{ name: "agent", conversations: [{ turns: repeated(), replayLimit }] }],
            },
          }),
        );
        const server = await startFromConfig(loadConfig(filename));
        stops.push(() => server.llmock.stop());
        const url = server.url + "/retry";
        const first = await send(url, "same", { messageId: "same" });
        const retry = await send(url, "same", { taskId: first.id, messageId: "same" }, true);
        if (replayLimit > 0) expect(retry).toEqual(first);
        else expect(retry.history).toHaveLength(4);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects invalid configuration limits", async () => {
    const config = {
      a2a: { agents: [{ name: "agent", conversations: [{ turns: repeated(), replayLimit: -1 }] }] },
    };
    let error: unknown;
    try {
      const server = await startFromConfig(config as AimockConfig);
      stops.push(() => server.llmock.stop());
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
  });

  it("forgets retained responses on reset and permits fresh reuse of an ID", async () => {
    const { mock, url } = await fixture(repeated(), false, { replayLimit: 2 });
    const first = await send(url, "same", { messageId: "shared" });
    mock.reset();
    await rejected(url, -32000, "same", { taskId: first.id, messageId: "shared" });
    expect(await list(url)).toEqual([]);
    mock
      .registerAgent({ name: "agent" })
      .onConversation("agent", [turn("same", DONE, "new")], { replayLimit: 1 });
    const fresh = await send(url, "same", { messageId: "shared" });
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.history[1].parts).toEqual([{ text: "new" }]);
    expect(await send(url, "same", { taskId: fresh.id, messageId: "shared" })).toEqual(fresh);
  });

  it("shares retry accounting with JSON-RPC notification and batch sends", async () => {
    const { url } = await fixture(repeated(), false, { replayLimit: 2 });
    const first = await send(url, "start", { messageId: "first" });
    const params = { message: message("next", { taskId: first.id, messageId: "next" }) };
    const raw = await post(url, [
      { jsonrpc: "2.0", method: "SendMessage", params },
      { jsonrpc: "2.0", id: "retry", method: "SendMessage", params },
    ]);
    const batch = JSON.parse(raw.data) as Wire[];
    expect(batch).toHaveLength(1);
    expect(batch[0].id).toBe("retry");
    expect(batch[0].error).toBeUndefined();
    const current = await getTask(url, first.id);
    expect(batch[0].result!.task).toEqual(current);
    expect(current.history).toHaveLength(4);
    expect(current.artifacts).toHaveLength(2);
  });
});

describe("task-bound conversation fixtures", () => {
  it(
    "exports a usable typed registration API and configuration surface",
    { timeout: 60_000 },
    async () => {
      const mock = new A2AMock().registerAgent({ name: "agent" });
      expect(mock.onConversation("agent", script())).toBe(mock);
      const run = spawn(
        process.execPath,
        [
          resolve(REPO_ROOT, "node_modules/typescript/bin/tsc"),
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--target",
          "ES2022",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          resolve(REPO_ROOT, "src/__tests__/conversation.types.ts"),
        ],
        { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
      let diagnostics = "";
      run.stdout.on("data", (chunk: Buffer) => {
        diagnostics += chunk.toString();
      });
      run.stderr.on("data", (chunk: Buffer) => {
        diagnostics += chunk.toString();
      });
      const status = await new Promise<number | null>((resolveStatus, reject) => {
        run.on("error", reject);
        run.on("close", resolveStatus);
      });
      expect(status, diagnostics).toBe(0);
    },
  );

  it.each(
    [
      { label: "parts-not-array", output: { parts: "text" } },
      { label: "invalid-part", output: { parts: [{ text: 17 }] } },
      { label: "text-part-media-type", output: { parts: [{ text: "ok", mediaType: 17 }] } },
      { label: "data-part-text", output: { parts: [{ data: { ok: true }, text: 17 }] } },
      { label: "text-part-url", output: { parts: [{ text: "ok", url: 17 }] } },
      { label: "artifacts-not-array", output: { artifacts: {} } },
      { label: "artifact-without-parts", output: { artifacts: [{ name: "missing" }] } },
      { label: "invalid-artifact-part", output: { artifacts: [{ parts: [null] }] } },
      {
        label: "artifact-part-text",
        output: { artifacts: [{ parts: [{ data: { ok: true }, text: 17 }] }] },
      },
      {
        label: "artifact-part-url",
        output: { artifacts: [{ parts: [{ text: "ok", url: 17 }] }] },
      },
      {
        label: "artifact-part-media-type",
        output: { artifacts: [{ parts: [{ text: "ok", mediaType: 17 }] }] },
      },
    ].flatMap((example) => [false, true].map((later) => ({ ...example, later }))),
  )(
    "rejects malformed response $label before registration (later=$later)",
    async ({ output, later }) => {
      const { mock, url } = await fixture();
      expect(() =>
        mock.onConversation("agent", [
          ...(later ? [turn("bad-output", INPUT)] : []),
          { pattern: later ? "bad-end" : "bad-output", response: { state: DONE, ...output } },
        ] as A2AConversationTurn[]),
      ).toThrow();
      await rejected(url, -32000, "bad-output", {});
      expect(await list(url)).toEqual([]);
      expect((await send(url, "start")).history[1].parts).toEqual([{ text: "question" }]);
    },
  );

  it("requires an explicitly registered agent and permits registration after rejection", async () => {
    const mock = new A2AMock();
    expect(() => mock.onConversation("agent", [turn("start", DONE, "discarded")])).toThrow();
    mock.registerAgent({ name: "agent" });
    register(mock, [turn("start", DONE, "registered")]);
    const url = await mock.start();
    stops.push(() => mock.stop());
    expect((await send(url, "start")).history[1].parts).toEqual([{ text: "registered" }]);
  });

  it.each(["empty", "missing-pattern", "missing-response", "numeric-pattern", "missing-state"])(
    "rejects %s definitions without partial registration and allows repair",
    async (bad) => {
      const { mock, url } = await fixture([turn("existing", DONE)]);
      const malformed: Record<string, unknown> = { pattern: "poison", response: { state: DONE } };
      if (bad === "missing-pattern") delete malformed.pattern;
      if (bad === "numeric-pattern") malformed.pattern = 17;
      if (bad === "missing-response") delete malformed.response;
      if (bad === "missing-state") malformed.response = {};
      const invalid = bad === "empty" ? [] : [turn("repair", INPUT, "bad-first"), malformed];
      expect(() => mock.onConversation("agent", invalid as A2AConversationTurn[])).toThrow();
      register(mock, [turn("repair", DONE, "repaired")]);
      const fixed = await send(url, "repair");
      expect(fixed.status.state).toBe(DONE);
      expect(fixed.history[1].parts).toEqual([{ text: "repaired" }]);
    },
  );

  it.each([DONE, FAILED, "TASK_STATE_CANCELED", "TASK_STATE_WORKING", "TASK_STATE_SUBMITTED"])(
    "rejects non-final state %s atomically",
    async (state) => {
      const { mock, url } = await fixture();
      expect(() =>
        mock.onConversation("agent", [turn("invalid", state), turn("end", DONE)]),
      ).toThrow();
      await rejected(url, -32000, "invalid", {});
      expect(await list(url)).toEqual([]);
    },
  );

  it.each([
    INPUT,
    "TASK_STATE_CANCELED",
    "TASK_STATE_WORKING",
    "TASK_STATE_SUBMITTED",
    "not-a-state",
  ])("rejects final state %s and supports a later valid registration", async (state) => {
    const { mock, url } = await fixture();
    expect(() => mock.onConversation("agent", [turn("invalid", state)])).toThrow();
    register(mock, [turn("invalid", FAILED)]);
    expect((await send(url, "invalid")).status.state).toBe(FAILED);
  });

  it.each([DONE, FAILED])(
    "accepts a one-turn %s conversation with empty optional output",
    async (state) => {
      const { url } = await fixture([
        { pattern: "", response: { state: state as typeof DONE | typeof FAILED } },
      ]);
      const task = await send(url, "");
      expect(task.status.state).toBe(state);
      expect(task.artifacts).toEqual([]);
      expect(task.history.map((m) => [m.role, m.parts])).toEqual([
        ["ROLE_USER", [{ text: "" }]],
        ["ROLE_AGENT", []],
      ]);
    },
  );

  it.each([false, true])(
    "uses case-sensitive substring matching and joins input text parts (stream=%s)",
    async (stream) => {
      const { url } = await fixture([turn("Hello [World]", INPUT), turn("Next (Step)", DONE)]);
      await rejected(url, -32000, "hello [world]", {}, stream);
      const task = await send(
        url,
        "unused",
        {
          parts: [
            { text: "prefix Hello" },
            { data: { ignored: true } },
            { text: "[World] suffix" },
          ],
        },
        stream,
      );
      expect(task.status.state).toBe(INPUT);
      expect(task.history[0].parts).toEqual([
        { text: "prefix Hello" },
        { data: { ignored: true } },
        { text: "[World] suffix" },
      ]);
      await rejected(url, -32000, "prefix next (step) suffix", { taskId: task.id }, stream);
      expect(await getTask(url, task.id)).toEqual(task);
      const nextParts = [
        { text: "prefix Next" },
        { data: { ignored: true } },
        { text: "(Step) suffix" },
      ];
      const done = await send(url, "unused", { taskId: task.id, parts: nextParts }, stream);
      expect(done.status.state).toBe(DONE);
      expect(done.history[2].parts).toEqual(nextParts);
    },
  );

  it.each([false, true])(
    "reuses RegExp patterns on independent tasks and repeated turns (stream=%s)",
    async (stream) => {
      const turns = [turn(/^same$/gi, INPUT, "first"), turn(/^same$/gi, DONE, "second")];
      const { url } = await fixture(turns);
      const first = await send(url, "SAME", {}, stream);
      const second = await send(url, "SAME", {}, stream);
      expect(first.id).not.toBe(second.id);
      for (const task of [first, second]) {
        await rejected(url, -32000, "not-the-next-pattern", { taskId: task.id }, stream);
        expect(await getTask(url, task.id)).toEqual(task);
        expect((await send(url, "SAME", { taskId: task.id }, stream)).status.state).toBe(DONE);
      }
    },
  );

  it.each([false, true])(
    "selects first turns in existing agent and pattern precedence (stream=%s)",
    async (stream) => {
      const mock = new A2AMock().registerAgent({ name: "agent" }).registerAgent({ name: "second" });
      register(mock, [turn("overlap", DONE, "second-agent")], "second");
      register(mock, [turn("overlap", DONE, "first")]);
      register(mock, [turn("overlap", DONE, "later-pattern")]);
      const url = await mock.start();
      stops.push(() => mock.stop());
      expect((await send(url, "overlap", {}, stream)).history[1].parts).toEqual([
        { text: "first" },
      ]);
    },
  );

  it("allocates fresh tasks and contexts when no IDs are supplied", async () => {
    const { url } = await fixture();
    const first = await send(url, "start");
    const second = await send(url, "start");
    expect(first.id).toEqual(expect.any(String));
    expect(first.id.length).toBeGreaterThan(0);
    expect(first.contextId.length).toBeGreaterThan(0);
    expect(second.id).not.toBe(first.id);
    expect(second.contextId).not.toBe(first.contextId);
    expect((await list(url)).map((t) => t.id).sort()).toEqual([first.id, second.id].sort());
  });

  it("keeps concurrent tasks independent with a shared context", async () => {
    const contextId = "shared";
    const { url } = await fixture();
    const [first, second, other] = await Promise.all([
      send(url, "start one", { contextId }),
      send(url, "start two", { contextId }),
      send(url, "start other", { contextId: "other" }),
    ]);
    expect(first.contextId).toBe(contextId);
    expect(second.contextId).toBe(contextId);
    expect(first.id).not.toBe(second.id);
    const next = await send(url, "answer", { taskId: first.id });
    expect(next.contextId).toBe(contextId);
    expect(next.history).toHaveLength(4);
    expect(await getTask(url, second.id)).toEqual(second);
    const secondNext = await send(url, "answer", { taskId: second.id });
    expect(secondNext.history).toHaveLength(4);
    const listed = (await list(url, { contextId })).map((t) => t.id);
    expect(listed.sort()).toEqual([first.id, second.id].sort());
    expect(listed).not.toContain(other.id);
  });

  it.each([false, true])(
    "treats an empty context ID as absent, as ListTasks does (stream=%s)",
    async (stream) => {
      const { url } = await fixture();
      const first = await send(url, "start one", { contextId: "" }, stream);
      const second = await send(url, "start two", { contextId: "" }, stream);
      expect(first.contextId).toMatch(/^ctx-/);
      expect(second.contextId).toMatch(/^ctx-/);
      expect(first.contextId).not.toBe(second.contextId);
      const next = await send(url, "answer", { taskId: first.id, contextId: "" }, stream);
      expect(next.contextId).toBe(first.contextId);
      expect((await list(url, { contextId: "" })).map((t) => t.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
      expect((await list(url, { contextId: first.contextId })).map((t) => t.id)).toEqual([
        first.id,
      ]);
    },
  );

  it("binds continuation to its original script despite overlapping registrations on other agents", async () => {
    const { mock, url } = await fixture([
      turn("alpha", INPUT, "alpha-first"),
      turn("common", DONE, "alpha-last"),
    ]);
    mock.registerAgent({ name: "other" });
    register(
      mock,
      [turn("beta", INPUT, "beta-first"), turn("common", FAILED, "beta-last")],
      "other",
    );
    register(mock, [turn("common", DONE, "unrelated")]);
    register(mock, [turn("delta", INPUT, "delta-first"), turn("common", FAILED, "delta-last")]);
    const alpha = await send(url, "alpha", { contextId: "shared-scripts" });
    const beta = await send(url, "beta", { contextId: "shared-scripts" });
    const delta = await send(url, "delta", { contextId: "shared-scripts" });
    const b = await send(url, "common", { taskId: beta.id });
    const d = await send(url, "common", { taskId: delta.id });
    const a = await send(url, "common", { taskId: alpha.id });
    expect(a.history[3].parts).toEqual([{ text: "alpha-last" }]);
    expect(b.history[3].parts).toEqual([{ text: "beta-last" }]);
    expect(b.status.state).toBe(FAILED);
    expect(d.history[3].parts).toEqual([{ text: "delta-last" }]);
    expect(d.status.state).toBe(FAILED);
  });

  it.each([false, true])(
    "rejects unknown task IDs without allocating or falling back (stream=%s)",
    async (stream) => {
      const { url } = await fixture();
      const live = await send(url, "start", { contextId: "shared" }, stream);
      for (const taskId of ["unknown", ""]) {
        await rejected(url, -32001, "start", { taskId, contextId: "shared" }, stream);
        expect(await list(url)).toEqual([live]);
        expect(await getTask(url, live.id)).toEqual(live);
      }
      expect((await send(url, "answer", { taskId: live.id }, stream)).history).toHaveLength(4);
      expect((await send(url, "start")).history).toHaveLength(2);
    },
  );

  it("does not accept task IDs belonging to another mock instance", async () => {
    const one = await fixture();
    const two = await fixture();
    const task = await send(one.url, "start");
    await rejected(two.url, -32001, "start", { taskId: task.id });
    expect(await list(two.url)).toEqual([]);
    expect((await send(one.url, "answer", { taskId: task.id })).history).toHaveLength(4);
  });

  it.each([false, true])(
    "rejects a conflicting context without mutation and then repairs (stream=%s)",
    async (stream) => {
      const { url } = await fixture();
      const task = await send(url, "start", { contextId: "original" });
      await rejected(url, -32602, "answer", { taskId: task.id, contextId: "conflict" }, stream);
      expect(await getTask(url, task.id)).toEqual(task);
      expect(await list(url)).toEqual([task]);
      const next = await send(url, "answer", { taskId: task.id, contextId: "original" }, stream);
      expect(next.id).toBe(task.id);
      expect(next.contextId).toBe("original");
      expect(next.history).toHaveLength(4);
    },
  );

  it.each([false, true])(
    "rejects a skipped or unrelated turn without consuming it (stream=%s)",
    async (stream) => {
      const { mock, url } = await fixture();
      mock.onMessage("agent", "wrong", [{ text: "legacy fallback" }]);
      register(mock, [turn("finish", DONE, "wrong-script")]);
      const task = await send(url, "start");
      for (const text of ["wrong", "finish", "start"]) {
        await rejected(url, -32000, text, { taskId: task.id }, stream);
        expect(await getTask(url, task.id)).toEqual(task);
        expect(await list(url)).toEqual([task]);
      }
      expect((await send(url, "answer", { taskId: task.id }, stream)).history).toHaveLength(4);
    },
  );

  it.each([DONE, FAILED])(
    "terminal state %s cannot restart a matching first turn",
    async (state) => {
      const { url } = await fixture([turn("again", state)]);
      const task = await send(url, "again");
      for (const stream of [false, true])
        await rejected(url, -32004, "again", { taskId: task.id }, stream);
      expect(await getTask(url, task.id)).toEqual(task);
      expect(await list(url)).toEqual([task]);
      expect((await send(url, "again")).id).not.toBe(task.id);
    },
  );

  it.each([
    { label: "blocking-streaming-blocking", modes: [false, true, false], state: DONE },
    { label: "streaming-blocking-streaming", modes: [true, false, true], state: FAILED },
    { label: "streaming-only", modes: [true, true, true], state: DONE },
  ])("switches transport paths across all three turns: $label", async ({ modes, state }) => {
    const turns = script();
    turns[2].response.state = state as typeof DONE | typeof FAILED;
    const { url } = await fixture(turns);
    const texts = ["start", "answer", "finish"];
    for (const text of texts.slice(1)) {
      await rejected(url, -32000, text, {}, modes[0]);
      expect(await list(url)).toEqual([]);
    }
    let task: A2ATask | undefined;
    for (let i = 0; i < texts.length; i++) {
      const previous = task;
      task = await send(url, texts[i], previous ? { taskId: previous.id } : {}, modes[i]);
      expect(task.status.state).toBe(i === 2 ? state : INPUT);
      expect(task.history).toHaveLength((i + 1) * 2);
      expect(task.artifacts).toHaveLength(i + 1);
      if (previous) {
        expect(task.id).toBe(previous.id);
        expect(task.contextId).toBe(previous.contextId);
      }
      expect(await getTask(url, task.id)).toEqual(task);
    }
  });

  it("records accepted input and replies exactly once in order, including repeated messages and IDs", async () => {
    const turns = [
      turn("same", INPUT, "one"),
      turn("same", INPUT, "two"),
      turn("same", DONE, "three"),
    ];
    const { url } = await fixture(turns);
    let task = await send(url, "same", { messageId: "" });
    task = await send(url, "same", { messageId: "same-id", taskId: task.id });
    task = await send(url, "same", { messageId: "same-id", taskId: task.id }, true);
    expect(task.history.map((m) => [m.role, m.parts])).toEqual([
      ...["one", "two", "three"].flatMap((text) => [
        ["ROLE_USER", [{ text: "same" }]],
        ["ROLE_AGENT", [{ text }]],
      ]),
    ]);
    expect(task.history.filter((m) => m.role === "ROLE_USER").map((m) => m.messageId)).toEqual([
      "",
      "same-id",
      "same-id",
    ]);
    expect(
      task.history
        .filter((m) => m.role === "ROLE_AGENT")
        .every((m) => typeof m.messageId === "string"),
    ).toBe(true);
  });

  it("accumulates rich parts and artifacts without loss, reordering, or cross-task contamination", async () => {
    const parts: A2APart[] = [
      { text: "" },
      { data: { nested: [null, false, 0, "", { key: "value" }] }, mediaType: "application/json" },
      { url: "https://example.invalid/doc", mediaType: "text/plain" },
    ];
    const artifacts = [
      { artifactId: "first", name: "n", description: "d", parts },
      { artifactId: "second", parts: [] },
    ];
    const turns: A2AConversationTurn[] = [
      { pattern: "start", response: { state: INPUT, parts, artifacts } },
      { pattern: "middle", response: { state: INPUT } },
      {
        pattern: "end",
        response: {
          state: DONE,
          parts: [],
          artifacts: [{ artifactId: "third", parts: [{ text: "last" }] }],
        },
      },
    ];
    const { url } = await fixture(turns);
    const other = await send(url, "start");
    const first = await send(url, "start", { parts: [{ text: "start" }, ...parts] }, true);
    const middle = await send(url, "middle", { taskId: first.id }, true);
    expect(middle.history[3].parts).toEqual([]);
    expect(middle.artifacts).toEqual(artifacts);
    const final = await send(url, "end", { taskId: first.id });
    expect(final.history[0].parts).toEqual([{ text: "start" }, ...parts]);
    expect(final.history[1].parts).toEqual(parts);
    expect(final.history[3].parts).toEqual([]);
    expect(final.history[5].parts).toEqual([]);
    expect(final.artifacts).toEqual([
      ...artifacts,
      { artifactId: "third", parts: [{ text: "last" }] },
    ]);
    expect(await getTask(url, other.id)).toEqual(other);
  });

  it("appends repeated artifact IDs and duplicate content without upserting", async () => {
    const first = { artifactId: "shared", parts: [{ data: { revision: 1 } }] };
    const second = { artifactId: "shared", parts: [{ data: { revision: 2 } }] };
    const { url } = await fixture([
      { pattern: "start", response: { state: INPUT, artifacts: [first, first] } },
      { pattern: "end", response: { state: DONE, artifacts: [second, first] } },
    ]);
    const task = await send(url, "start");
    expect(task.artifacts).toEqual([first, first]);
    const done = await send(url, "end", { taskId: task.id }, true);
    expect(done.artifacts).toEqual([first, first, second, first]);
    expect((await getTask(url, task.id)).artifacts).toEqual([first, first, second, first]);
  });

  it.each([false, true])(
    "accepts empty and nontext-only message parts (stream=%s)",
    async (stream) => {
      const { url } = await fixture([turn("", INPUT), turn("", DONE)]);
      const first = await send(url, "unused", { parts: [] }, stream);
      expect(first.history[0].parts).toEqual([]);
      const parts = [
        { data: { values: [null, false, 0] } },
        { url: "https://example.invalid/data" },
      ];
      const done = await send(url, "unused", { taskId: first.id, parts }, !stream);
      expect(done.status.state).toBe(DONE);
      expect(done.history.map((entry) => entry.parts)).toEqual([
        [],
        [{ text: "reply" }],
        parts,
        [{ text: "reply" }],
      ]);
      expect(await getTask(url, done.id)).toEqual(done);
    },
  );

  it("keeps active bindings when another fixture is registered", async () => {
    const { mock, url } = await fixture([turn("start", INPUT), turn("end", DONE, "original")]);
    const active = await send(url, "start");
    mock.onConversation("agent", [turn("fresh", INPUT), turn("end", FAILED, "new")]);
    const original = await send(url, "end", { taskId: active.id }, true);
    expect(original.status.state).toBe(DONE);
    expect(original.history[3].parts).toEqual([{ text: "original" }]);
    const fresh = await send(url, "fresh");
    const final = await send(url, "end", { taskId: fresh.id });
    expect(final.status.state).toBe(FAILED);
    expect(final.history[3].parts).toEqual([{ text: "new" }]);
    expect(await getTask(url, active.id)).toEqual(original);
  });

  it("GetTask and ListTasks expose current accumulated snapshots and filters", async () => {
    const { url } = await fixture([turn("start", INPUT, "partial"), turn("end", DONE, "final")]);
    const one = await send(url, "start", { contextId: "group" });
    const two = await send(url, "start", { contextId: "other" });
    const done = await send(url, "end", { taskId: one.id });
    expect(await getTask(url, done.id)).toEqual(done);
    expect(await list(url, { contextId: "group", status: DONE })).toEqual([done]);
    expect(await list(url, { status: INPUT })).toEqual([two]);
    expect(await list(url, { contextId: "group", status: INPUT })).toEqual([]);
  });

  it("cancel preserves accepted data, rejects replay, and leaves a sibling task usable", async () => {
    const { url } = await fixture();
    const one = await send(url, "start", {}, true);
    const two = await send(url, "start");
    const canceled = (await rpc(url, "CancelTask", { id: one.id })).result!.task!;
    expect(canceled.status.state).toBe("TASK_STATE_CANCELED");
    expect(canceled.history).toEqual(one.history);
    expect(canceled.artifacts).toEqual(one.artifacts);
    await rejected(url, -32004, "answer", { taskId: one.id }, true);
    await rejected(url, -32004, "start", { taskId: one.id });
    expect(await getTask(url, one.id)).toEqual(canceled);
    expect((await send(url, "answer", { taskId: two.id })).history).toHaveLength(4);
  });

  it("reset removes scripts and tasks and permits fresh registration without reviving old IDs", async () => {
    const { mock, url } = await fixture();
    const task = await send(url, "start");
    expect(mock.reset()).toBe(mock);
    expect(await list(url)).toEqual([]);
    expect((await rpc(url, "GetTask", { id: task.id })).error).toBeDefined();
    await rejected(url, -32000, "start", {});
    mock.registerAgent({ name: "agent" });
    register(mock);
    await rejected(url, -32000, "answer", { taskId: task.id });
    const fresh = await send(url, "start");
    expect(fresh.id).not.toBe(task.id);
    expect(fresh.history).toHaveLength(2);
  });

  it("resetting one mock leaves another mock's live conversation intact", async () => {
    const one = await fixture([turn("start", INPUT), turn("end", DONE, "first")]);
    const two = await fixture([turn("start", INPUT), turn("end", FAILED, "second")], true);
    const first = await send(one.url, "start", { contextId: "shared" });
    const second = await send(two.url, "start", { contextId: "shared" });
    one.mock.reset();
    expect(await list(one.url)).toEqual([]);
    expect(await getTask(two.url, second.id)).toEqual(second);
    const final = await send(two.url, "end", { taskId: second.id }, true);
    expect(final.status.state).toBe(FAILED);
    expect(final.history[3].parts).toEqual([{ text: "second" }]);
    one.mock.registerAgent({ name: "agent" });
    register(one.mock, [turn("fresh", DONE, "new-first")]);
    await rejected(one.url, -32000, "end", { taskId: first.id });
    expect((await send(one.url, "fresh")).history[1].parts).toEqual([{ text: "new-first" }]);
    expect(await getTask(two.url, second.id)).toEqual(final);
  });

  it("supports mounted operation with a nested route", async () => {
    const { url } = await fixture(script(), true);
    const first = await send(url, "start", {}, true);
    const second = await send(url, "answer", { taskId: first.id });
    expect(second.history).toHaveLength(4);
    expect(await getTask(url, second.id)).toEqual(second);
  });

  it("loads JSON conversation definitions and preserves legacy config fixtures", async () => {
    const directory = mkdtempSync(join(tmpdir(), "a2a-4540d5-"));
    const filename = join(directory, "config.json");
    const turns = script();
    try {
      writeFileSync(
        filename,
        JSON.stringify({
          a2a: {
            path: "/configured",
            agents: [
              {
                name: "agent",
                conversations: [
                  { turns },
                  { turns: [turn("second-script", FAILED, "second result")] },
                ],
                messages: [{ pattern: "legacy", parts: [{ text: "legacy reply" }] }],
              },
              {
                name: "other",
                conversations: [{ turns: [turn("other-agent", DONE, "other result")] }],
              },
            ],
          },
        }),
      );
      const server = await startFromConfig(loadConfig(filename));
      stops.push(() => server.llmock.stop());
      const url = server.url + "/configured";
      const first = await send(url, "start");
      expect(first.status.state).toBe(INPUT);
      const second = await send(url, "answer", { taskId: first.id }, true);
      expect(second.status.state).toBe(INPUT);
      const final = await send(url, "finish", { taskId: first.id });
      expect(final.status.state).toBe(DONE);
      expect(final.history.map((entry) => entry.parts)).toEqual([
        [{ text: "start" }],
        turns[0].response.parts,
        [{ text: "answer" }],
        turns[1].response.parts,
        [{ text: "finish" }],
        turns[2].response.parts,
      ]);
      expect(final.artifacts).toEqual(turns.flatMap((entry) => entry.response.artifacts ?? []));
      expect(await getTask(url, first.id)).toEqual(final);
      const otherScript = await send(url, "second-script");
      expect(otherScript.status.state).toBe(FAILED);
      expect(otherScript.history[1].parts).toEqual([{ text: "second result" }]);
      expect((await send(url, "other-agent", {}, true)).history[1].parts).toEqual([
        { text: "other result" },
      ]);
      expect(
        (await rpc(url, "SendMessage", { message: message("legacy") })).result!.message!.parts,
      ).toEqual([{ text: "legacy reply" }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid state sequences loaded from configuration", async () => {
    const config = {
      a2a: { agents: [{ name: "bad", conversations: [{ turns: [turn("bad", INPUT)] }] }] },
    } as AimockConfig;
    let error: unknown;
    try {
      const server = await startFromConfig(config);
      stops.push(() => server.llmock.stop());
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
  });

  it("preserves legacy precedence while preventing continuation fallback to a legacy fixture", async () => {
    const mock = new A2AMock().registerAgent({ name: "agent" });
    mock.onTask("agent", "legacy-first", [{ parts: [{ text: "legacy artifact" }] }]);
    register(mock, [turn("legacy-first", DONE, "not-selected")]);
    register(mock, [turn("new-first", INPUT, "selected"), turn("continue", DONE, "done")]);
    mock.onMessage("agent", "new-first", [{ text: "not-selected" }]);
    mock.onMessage("agent", "message-first", [{ text: "earlier-message" }]);
    register(mock, [turn("message-first", DONE, "not-selected")]);
    register(mock, [turn("conversation-first", DONE, "earlier-conversation")]);
    mock.onTask("agent", "conversation-first", [{ parts: [{ text: "not-selected" }] }]);
    mock.onStreamingTask("agent", "stream-a", [
      { type: "artifact", parts: [{ text: "earlier-stream" }] },
      { type: "status", state: DONE },
    ]);
    register(mock, [turn("stream-a", DONE, "not-selected")]);
    register(mock, [turn("stream-b", DONE, "earlier-conversation-stream")]);
    mock.onStreamingTask("agent", "stream-b", [
      { type: "artifact", parts: [{ text: "not-selected" }] },
      { type: "status", state: DONE },
    ]);
    const url = await mock.start();
    stops.push(() => mock.stop());
    expect((await send(url, "legacy-first")).artifacts).toEqual([
      { parts: [{ text: "legacy artifact" }] },
    ]);
    const task = await send(url, "new-first");
    expect(task.history[1].parts).toEqual([{ text: "selected" }]);
    const earlierMessage = await rpc(url, "SendMessage", { message: message("message-first") });
    expect(earlierMessage.error).toBeUndefined();
    expect(earlierMessage.result!.message!.parts).toEqual([{ text: "earlier-message" }]);
    expect((await send(url, "conversation-first")).history[1].parts).toEqual([
      { text: "earlier-conversation" },
    ]);
    for (const text of ["legacy-first", "message-first"]) {
      expect((await send(url, text, {}, true)).history[1].parts).toEqual([
        { text: "not-selected" },
      ]);
    }
    for (const streaming of [false, true]) {
      const legacy = await rpc(url, streaming ? "SendStreamingMessage" : "SendMessage", {
        message: message("stream-a"),
      });
      expect(legacy.error).toBeUndefined();
      expect(
        (await getTask(url, legacy.result!.task!.id)).artifacts.map((artifact) => artifact.parts),
      ).toEqual([[{ text: "earlier-stream" }]]);
      expect((await send(url, "stream-b", {}, streaming)).history[1].parts).toEqual([
        { text: "earlier-conversation-stream" },
      ]);
    }
    await rejected(url, -32000, "legacy-first", { taskId: task.id });
    expect((await send(url, "continue", { taskId: task.id })).status.state).toBe(DONE);
  });

  it.each(["message", "task"])(
    "selects an eligible conversation for streaming after an earlier %s fixture",
    async (kind) => {
      const mock = new A2AMock().registerAgent({ name: "agent" });
      if (kind === "message") mock.onMessage("agent", "overlap", [{ text: "blocking-only" }]);
      else mock.onTask("agent", "overlap", [{ parts: [{ text: "blocking-only" }] }]);
      register(mock, [turn("overlap", DONE, "eligible-conversation")]);
      const url = await mock.start();
      stops.push(() => mock.stop());
      expect((await send(url, "overlap", {}, true)).history[1].parts).toEqual([
        { text: "eligible-conversation" },
      ]);
    },
  );

  it("uses normal JSON-RPC batch and notification semantics for SendMessage", async () => {
    const method = "SendMessage";
    const { url } = await fixture([turn("start", INPUT), turn("end", DONE)]);
    const initial = await post(url, [
      { jsonrpc: "2.0", id: "initial", method, params: { message: message("start") } },
      { jsonrpc: "2.0", method, params: { message: message("start") } },
    ]);
    const initialBatch = JSON.parse(initial.data) as Wire[];
    expect(initialBatch).toHaveLength(1);
    expect(initialBatch[0].id).toBe("initial");
    expect(initialBatch[0].error).toBeUndefined();
    const first = initialBatch[0].result!.task!;
    expect(first.status.state).toBe(INPUT);
    const created = await list(url);
    expect(created).toHaveLength(2);
    expect(new Set(created.map((task) => task.id)).size).toBe(2);
    for (const task of created) {
      expect(task.status.state).toBe(INPUT);
      expect(task.history.map((entry) => entry.parts)).toEqual([
        [{ text: "start" }],
        [{ text: "reply" }],
      ]);
    }
    const raw = await post(url, [
      {
        jsonrpc: "2.0",
        method,
        params: { message: message("end", { taskId: first.id }) },
      },
      { jsonrpc: "2.0", id: "read", method: "GetTask", params: { id: first.id } },
    ]);
    const batch = JSON.parse(raw.data) as Wire[];
    expect(batch).toHaveLength(1);
    expect(batch[0].id).toBe("read");
    expect(batch[0].result!.task!.status.state).toBe(DONE);
    expect(batch[0].result!.task!.history).toHaveLength(4);
  });
});

it("preserves every JSON data field in accepted history and artifact snapshots", async () => {
  const data = JSON.parse(
    '{"__proto__":{"marker":"kept"},"constructor":[0,false],"toString":"value"}',
  );
  const firstTurn = turn("step", INPUT);
  firstTurn.response.parts = [{ data }];
  firstTurn.response.artifacts = [{ name: "json", parts: [{ data }] }];
  const { url } = await fixture([firstTurn, turn("finish", DONE)], false, { replayLimit: 1 });
  const parts = [{ text: "step" }, { data }];
  const first = await send(url, "step", { parts });
  expect(first.history[0].parts).toEqual(parts);
  expect(first.history[1].parts).toEqual([{ data }]);
  expect(first.artifacts).toEqual(firstTurn.response.artifacts);
  const final = await send(url, "finish", { taskId: first.id });
  expect(final.history.slice(0, 2)).toEqual(first.history);
  expect(final.artifacts[0]).toEqual(first.artifacts[0]);
});

it("compares every JSON data field before replay and preserves state on conflict", async () => {
  const { url } = await fixture([turn("step", INPUT), turn("step", DONE)], false, {
    replayLimit: 2,
  });
  const data = JSON.parse('{"label":"same","__proto__":{"marker":1}}');
  const parts = [{ text: "step" }, { data }];
  const first = await send(url, "step", { parts, messageId: "retained" });
  const reordered = JSON.parse('{"__proto__":{"marker":1},"label":"same"}');
  expect(
    await send(
      url,
      "step",
      {
        taskId: first.id,
        messageId: "retained",
        parts: [{ text: "step" }, { data: reordered }],
      },
      true,
    ),
  ).toEqual(first);
  const changed = JSON.parse('{"label":"same","__proto__":{"marker":2}}');
  await rejected(url, -32602, "step", {
    taskId: first.id,
    messageId: "retained",
    parts: [{ text: "step" }, { data: changed }],
  });
  expect(await getTask(url, first.id)).toEqual(first);
  const final = await send(url, "step", { taskId: first.id, messageId: "new" });
  expect(final.history).toHaveLength(4);
});

describe("legacy behavior when conversations do not own the task", () => {
  async function legacyMock(withConversation = false) {
    const mock = new A2AMock().registerAgent({ name: "agent" });
    mock.onMessage("agent", "ping", [{ text: "pong" }]);
    mock.onTask("agent", "hello", [{ parts: [{ text: "hello artifact" }] }]);
    mock.onStreamingTask("agent", "stream", [
      { type: "artifact", parts: [{ text: "streamed" }] },
      { type: "status", state: DONE },
    ]);
    if (withConversation) register(mock, [turn("start", INPUT), turn("end", DONE)]);
    const url = await mock.start();
    stops.push(() => mock.stop());
    return url;
  }

  it.each([false, true])(
    "serves legacy fixtures for task IDs a conversation did not create (conversation=%s)",
    async (withConversation) => {
      const url = await legacyMock(withConversation);
      const legacy = (await rpc(url, "SendMessage", { message: message("hello") })).result!.task!;
      const again = await rpc(url, "SendMessage", {
        message: message("hello", { taskId: legacy.id }),
      });
      expect(again.error).toBeUndefined();
      expect(again.result!.task!.artifacts).toEqual([{ parts: [{ text: "hello artifact" }] }]);
      for (const taskId of ["client-task", null]) {
        const pong = await rpc(url, "SendMessage", { message: message("ping", { taskId }) });
        expect(pong.error).toBeUndefined();
        expect(pong.result!.message!.parts).toEqual([{ text: "pong" }]);
      }
      const raw = await post(url, {
        jsonrpc: "2.0",
        id: "stream",
        method: "SendStreamingMessage",
        params: { message: message("stream", { taskId: legacy.id }) },
      });
      expect(raw.type).toMatch(/^text\/event-stream/);
      expect(envelopes(raw).at(-1)!.result!.task!.status.state).toBe(DONE);
      for (const text of ["ping", "stream"]) {
        const batch = await post(url, [
          {
            jsonrpc: "2.0",
            id: "batch",
            method: "SendStreamingMessage",
            params: { message: message(text, { taskId: legacy.id }) },
          },
        ]);
        expect(JSON.parse(batch.data)).toEqual([{ jsonrpc: "2.0", id: "batch", result: null }]);
      }
    },
  );

  it.each([
    { label: "without jsonrpc", body: { id: "loose", method: "SendStreamingMessage" } },
    { label: "without id", body: { jsonrpc: "2.0", method: "SendStreamingMessage" } },
  ])("streams SendStreamingMessage $label over SSE", async ({ body }) => {
    const url = await legacyMock();
    const raw = await post(url, { ...body, params: { message: message("stream") } });
    expect(raw.type).toMatch(/^text\/event-stream/);
    expect(envelopes(raw).at(-1)!.result!.task!.status.state).toBe(DONE);
  });
});

describe("conversation request validation and isolation", () => {
  it("journals mounted conversation streams with the request URL", async () => {
    const mock = new A2AMock().registerAgent({ name: "agent" });
    mock.onConversation("agent", script());
    const llm = new LLMock();
    llm.mount("/nested/a2a", mock);
    await llm.start();
    stops.push(() => llm.stop());
    await send(`${llm.url}/nested/a2a?testId=probe`, "start", {}, true);
    expect(llm.getRequests().map((entry) => entry.path)).toEqual(["/nested/a2a?testId=probe"]);
  });

  it("keeps the registered turns when the caller mutates its array afterwards", async () => {
    const turns = [turn("start", INPUT, "question"), turn("finish", DONE, "result")];
    const { url } = await fixture(turns);
    const first = await send(url, "start");
    turns.pop();
    turns[0].response.state = "TASK_STATE_WORKING" as A2AConversationTurn["response"]["state"];
    turns[0].response.parts = [{ text: 17 as unknown as string }];
    const done = await send(url, "finish", { taskId: first.id });
    expect(done.status.state).toBe(DONE);
    expect(done.history[3].parts).toEqual([{ text: "result" }]);
    const again = await send(url, "start");
    expect(again.status.state).toBe(INPUT);
    expect(again.history[1].parts).toEqual([{ text: "question" }]);
  });

  it.each([false, true])(
    "rejects malformed IDs and parts with invalid params (stream=%s)",
    async (stream) => {
      const { url } = await fixture();
      for (const extra of [
        { taskId: null },
        { taskId: 123 },
        { contextId: null },
        { contextId: 7 },
        { messageId: 5 },
        { messageId: null },
        { parts: [null, { text: "start" }] },
        { parts: [42, { text: "start" }] },
      ]) {
        const raw = await post(url, {
          jsonrpc: "2.0",
          id: "bad",
          method: stream ? "SendStreamingMessage" : "SendMessage",
          params: { message: message("start", extra) },
        });
        const [response] = envelopes(raw);
        expect(response.error, JSON.stringify(extra)).toMatchObject({ code: -32602 });
      }
      expect(await list(url)).toEqual([]);
    },
  );

  it("keeps legacy responses for malformed requests that match no conversation", async () => {
    const mock = new A2AMock().registerAgent({ name: "agent" });
    mock.onMessage("agent", "ping", [{ text: "pong" }]);
    register(mock);
    const url = await mock.start();
    stops.push(() => mock.stop());
    const pong = await rpc(url, "SendMessage", { message: message("ping", { taskId: null }) });
    expect(pong.result!.message!.parts).toEqual([{ text: "pong" }]);
    const nullPart = await rpc(url, "SendMessage", {
      message: message("ping", { parts: [null, { text: "ping" }] }),
    });
    expect(nullPart.error!.code).toBe(-32603);
  });
});

describe("conversation turn copies", () => {
  it("validates the stored copy, so accessors cannot pass validation and store other values", async () => {
    let stateReads = 0;
    const stateResponse = { parts: [{ text: "state" }] } as A2AConversationTurn["response"];
    Object.defineProperty(stateResponse, "state", {
      enumerable: true,
      get: () => (stateReads++ === 0 ? DONE : "TASK_STATE_WORKING"),
    });
    let partReads = 0;
    const partResponse = { state: DONE } as A2AConversationTurn["response"];
    Object.defineProperty(partResponse, "parts", {
      enumerable: true,
      get: () => (partReads++ < 2 ? [{ text: "parts" }] : [{ text: 17 }]),
    });
    const mock = new A2AMock().registerAgent({ name: "agent" });
    mock.onConversation("agent", [{ pattern: "state", response: stateResponse }]);
    mock.onConversation("agent", [{ pattern: "parts", response: partResponse }]);
    const url = await mock.start();
    stops.push(() => mock.stop());
    expect((await send(url, "state")).status.state).toBe(DONE);
    expect((await send(url, "parts")).history[1].parts).toEqual([{ text: "parts" }]);
  });
});
