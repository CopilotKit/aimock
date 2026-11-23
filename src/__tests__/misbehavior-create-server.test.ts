import * as http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { loadFixtureFile } from "../index.js";
import type { Fixture, SSEChunk } from "../types.js";
import { getFixtureMisbehaviorPosition, fixtureMisbehaviorSourceKey } from "../misbehavior.js";
import { WebSocketConnection } from "../ws-framing.js";
import { connectWebSocket, type WSTestClient } from "./ws-test-client.js";
import { httpPost, stopDriftServer } from "./drift/helpers.js";
import { LLMock, createServer } from "./helpers/misbehavior-enabled.js";

const args = '{"text":"abcdef"}';
const request = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "record text" }],
  stream: true,
  stream_options: { include_usage: true },
};
function faultFixture(): Fixture {
  return {
    match: {},
    response: { toolCalls: [{ name: "record_text", arguments: args }] },
    misbehavior: { faults: [{ fault: "stop-length-mid-tool", at: 0.5, times: 1 }] },
  };
}
function assertCutStream(body: string) {
  const frames = body.trim().split(/\r?\n\r?\n/);
  expect(frames.filter((frame) => frame === "data: [DONE]")).toHaveLength(1);
  expect(frames.at(-1)).toBe("data: [DONE]");
  const chunks: SSEChunk[] = frames.slice(0, -1).map((frame) => JSON.parse(frame.slice(6)));
  const calls = chunks.flatMap((chunk) =>
    chunk.choices.flatMap((choice) => choice.delta.tool_calls ?? []),
  );
  expect(calls.every((call) => call.index === 0)).toBe(true);
  expect(calls.map((call) => call.function?.arguments ?? "").join("")).toBe(
    args.slice(0, Math.max(1, Math.floor(args.length * 0.5))),
  );
  const terminal = chunks.findIndex((chunk) =>
    chunk.choices.some((choice) => choice.finish_reason === "length"),
  );
  expect(terminal).toBeGreaterThan(0);
  expect(
    chunks.flatMap((chunk) => chunk.choices).filter((choice) => choice.finish_reason),
  ).toHaveLength(1);
  expect(chunks[terminal + 1].choices).toEqual([]);
  expect(chunks[terminal + 1].usage).toBeDefined();
  expect(terminal + 2).toBe(chunks.length);
}

for (const addition of ["initial", "push", "splice", "unshift", "index"] as const) {
  test(`raw createServer K5 ${addition} produces a clean length stream`, async () => {
    const fixture = faultFixture();
    const fixtures: Fixture[] = addition === "initial" ? [fixture] : [];
    const server = await createServer(fixtures, { port: 0, chunkSize: 4 });
    try {
      if (addition === "push") fixtures.push(fixture);
      if (addition === "splice") fixtures.splice(0, 0, fixture);
      if (addition === "unshift") fixtures.unshift(fixture);
      if (addition === "index") fixtures[0] = fixture;
      const result = await httpPost(`${server.url}/v1/chat/completions`, request);
      console.log(JSON.stringify({ cell: addition, ...result }));
      expect(result.status).toBe(200);
      assertCutStream(result.body);
      expect(fixtures[0]).toBe(fixture);
    } finally {
      await stopDriftServer(server);
    }
  });
}

test("raw fixture nonstream cut and fresh equal replacement preserve separate times budgets", async () => {
  const original = faultFixture();
  const fixtures = [original];
  const server = await createServer(fixtures, { port: 0 });
  try {
    const url = `${server.url}/v1/chat/completions`;
    const first = await httpPost(url, { ...request, stream: false });
    console.log(JSON.stringify({ cell: "replacement-first", ...first }));
    expect(first.status).toBe(200);
    const firstPosition = getFixtureMisbehaviorPosition(original);
    expect(firstPosition).toBeTruthy();
    const cut = JSON.parse(first.body);
    expect(cut.choices[0].message.tool_calls[0].function.arguments).toBe(
      args.slice(0, Math.floor(args.length * 0.5)),
    );
    expect(cut.choices[0].finish_reason).toBe("length");
    const repeat = await httpPost(url, { ...request, stream: false });
    expect(JSON.parse(repeat.body).choices[0].message.tool_calls[0].function.arguments).toBe(args);
    const replacement = faultFixture();
    fixtures.splice(0, 1, replacement);
    const fresh = await httpPost(url, { ...request, stream: false });
    expect(fresh.status).toBe(200);
    expect(JSON.parse(fresh.body).choices[0].finish_reason).toBe("length");
    expect(getFixtureMisbehaviorPosition(replacement)).not.toBe(firstPosition);
    fixtures.unshift(original);
    await httpPost(url, { ...request, stream: false });
    expect(getFixtureMisbehaviorPosition(original)).toBe(firstPosition);
    expect(fixtures[0]).toBe(original);
    expect(fixtures[1]).toBe(replacement);
  } finally {
    await stopDriftServer(server);
  }
});

test("raw equal predicates get distinct stable identities before config mutation", async () => {
  const first: Fixture = { match: { predicate: () => true }, response: { content: "unchanged" } };
  const second: Fixture = { match: { predicate: () => true }, response: { content: "unchanged" } };
  const fixtures = [first, second];
  const server = await createServer(fixtures, { port: 0 });
  try {
    const positions = fixtures.map(getFixtureMisbehaviorPosition);
    console.log(JSON.stringify({ cell: "predicate-identities", positions }));
    expect(positions.every(Boolean)).toBe(true);
    expect(new Set(positions).size).toBe(2);
    const config = { faults: [{ fault: "empty-response" as const, times: 1 }] };
    first.misbehavior = config;
    second.misbehavior = config;
    expect(fixtureMisbehaviorSourceKey(first, config)).not.toBe(
      fixtureMisbehaviorSourceKey(second, config),
    );
    for (const fixture of [first, second]) {
      fixtures.splice(0, fixtures.length, fixture);
      const response = await httpPost(`${server.url}/v1/chat/completions`, {
        ...request,
        stream: false,
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).choices[0].message.content ?? "").toBe("");
    }
    expect([first, second].map(getFixtureMisbehaviorPosition)).toEqual(positions);
  } finally {
    await stopDriftServer(server);
  }
});

test("loaded and LLMock positions survive raw ingress without cloning objects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aimock-ingress-"));
  const path = join(dir, "fixtures.json");
  await writeFile(
    path,
    JSON.stringify({
      fixtures: [
        {
          match: { userMessage: "loaded" },
          response: { content: "loaded" },
          misbehavior: "empty-response",
        },
      ],
    }),
  );
  const loaded = loadFixtureFile(path)[0];
  const mock = new LLMock();
  mock.addFixture({
    match: { userMessage: "code" },
    response: { content: "code" },
    misbehavior: "empty-response",
  });
  const code = mock.getFixtures()[0];
  const fixtures = [loaded, code];
  const positions = fixtures.map(getFixtureMisbehaviorPosition);
  const server = await createServer(fixtures, { port: 0 });
  try {
    for (const text of ["loaded", "code"]) {
      const response = await httpPost(`${server.url}/v1/chat/completions`, {
        ...request,
        stream: false,
        messages: [{ role: "user", content: text }],
      });
      expect(response.status).toBe(200);
    }
    expect(fixtures).toEqual([loaded, code]);
    expect(fixtures[0]).toBe(loaded);
    expect(fixtures[1]).toBe(code);
    expect(fixtures.map(getFixtureMisbehaviorPosition)).toEqual(positions);
  } finally {
    await stopDriftServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("raw malformed config keeps request-time 501 and no-config output remains unchanged", async () => {
  const fixture: Fixture = { match: {}, response: { content: "unchanged" } };
  const server = await createServer([fixture], { port: 0 });
  try {
    const first = await httpPost(`${server.url}/v1/chat/completions`, {
      ...request,
      stream: false,
    });
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body).choices[0].message.content).toBe("unchanged");
    fixture.misbehavior = JSON.parse('{"faults":"bad"}');
    const invalid = await httpPost(`${server.url}/v1/chat/completions`, {
      ...request,
      stream: false,
    });
    expect(invalid.status).toBe(501);
    expect(JSON.parse(invalid.body).error.code).toBe("aimock_misbehavior_not_applicable");
    expect(invalid.body).not.toContain("Missing fixture misbehavior position");
  } finally {
    await stopDriftServer(server);
  }
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const wsModes = [
  { name: "responses", path: "/v1/responses" },
  { name: "realtime", path: "/v1/realtime?model=gpt-realtime" },
  {
    name: "gemini",
    path: "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
  },
] as const;

function turnMessage(mode: string, text: string): string {
  if (mode === "responses")
    return JSON.stringify({ type: "response.create", input: [{ role: "user", content: text }] });
  if (mode === "realtime") return JSON.stringify({ type: "response.create", event_id: text });
  return JSON.stringify({
    clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true },
  });
}

async function waitForTwoCompleted(ws: WSTestClient, mode: string) {
  let count = 1;
  for (;;) {
    const messages = await ws.waitForMessages(count++);
    const completed = messages
      .map((message) => JSON.parse(message))
      .filter((event) =>
        mode === "gemini"
          ? event.serverContent?.turnComplete
          : event.type === (mode === "responses" ? "response.completed" : "response.done"),
      );
    if (completed.length === 2) return messages;
  }
}

for (const mode of wsModes) {
  test(`queued ${mode.name} scans live fixture replacement after complete frame arrival`, async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondArrived = deferred();
    const secondEntered = deferred();
    const order: string[] = [];
    let positionAtFactory: string | undefined;
    const first: Fixture = {
      match: {},
      response: async () => {
        order.push("first-start");
        firstEntered.resolve();
        await releaseFirst.promise;
        order.push("first-end");
        return { content: "FIRST" };
      },
    };
    const second: Fixture = {
      match: {},
      response: () => {
        order.push("second");
        positionAtFactory = getFixtureMisbehaviorPosition(second);
        secondEntered.resolve();
        return { content: "SECOND" };
      },
    };
    const fixtures = [first];
    const server = await createServer(fixtures, { port: 0, chunkSize: 100 });
    const secondMessage = turnMessage(mode.name, "second");
    const originalEmit = WebSocketConnection.prototype.emit;
    const observed = vi.spyOn(WebSocketConnection.prototype, "emit").mockImplementation(function (
      this: WebSocketConnection,
      event,
      ...values
    ) {
      const result = originalEmit.call(this, event, ...values);
      if (event === "message" && values[0] === secondMessage) secondArrived.resolve();
      return result;
    });
    let ws: WSTestClient | undefined;
    try {
      ws = await connectWebSocket(server.url, mode.path);
      if (mode.name === "gemini") {
        ws.send(JSON.stringify({ setup: { model: "gemini-2.0-flash" } }));
        await ws.waitForMessages(1);
      }
      if (mode.name === "realtime") {
        await ws.waitForMessages(1);
        ws.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "turn" }],
            },
          }),
        );
      }
      ws.send(turnMessage(mode.name, "first"));
      await firstEntered.promise;
      ws.send(secondMessage);
      await secondArrived.promise;
      expect(order).toEqual(["first-start"]);
      fixtures.splice(0, 1, second);
      releaseFirst.resolve();
      await secondEntered.promise;
      const messages = await waitForTwoCompleted(ws, mode.name);
      console.log(
        JSON.stringify({ cell: `queued-${mode.name}`, order, positionAtFactory, messages }),
      );
      expect(order).toEqual(["first-start", "first-end", "second"]);
      expect(positionAtFactory).toBeTruthy();
      expect(getFixtureMisbehaviorPosition(second)).toBe(positionAtFactory);
      expect(messages.join("\n")).toContain("FIRST");
      expect(messages.join("\n")).toContain("SECOND");
      expect(server.journal.getAll()).toHaveLength(2);
    } finally {
      releaseFirst.resolve();
      ws?.destroy();
      observed.mockRestore();
      await stopDriftServer(server);
    }
  });
}

for (const path of ["/v1/chat/completions", "/v1/responses"]) {
  test(`raw array additions during HTTP body await are visible on ${path}`, async () => {
    const fixtures: Fixture[] = [];
    let positionAtFactory: string | undefined;
    const fixture: Fixture = {
      ...faultFixture(),
      response: () => {
        positionAtFactory = getFixtureMisbehaviorPosition(fixture);
        return { toolCalls: [{ name: "record_text", arguments: args }] };
      },
    };
    const server = await createServer(fixtures, { port: 0, chunkSize: 4 });
    const arrived = deferred();
    server.server.once("request", () => arrived.resolve());
    try {
      const payload = JSON.stringify(
        path === "/v1/responses"
          ? { model: "gpt-4o-mini", input: "record text", stream: true }
          : request,
      );
      let client: http.ClientRequest;
      const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
        client = http.request(
          `${server.url}${path}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            },
          },
          (response) => {
            let body = "";
            response.on("data", (part: Buffer) => {
              body += part.toString();
            });
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
          },
        );
        client.on("error", reject);
        client.write(payload.slice(0, 1));
      });
      await arrived.promise;
      fixtures.push(fixture);
      client!.end(payload.slice(1));
      const response = await result;
      console.log(JSON.stringify({ cell: `body-await-${path}`, positionAtFactory, ...response }));
      expect(positionAtFactory).toBeTruthy();
      if (path === "/v1/chat/completions") {
        expect(response.status).toBe(200);
        assertCutStream(response.body);
      } else {
        expect(response.status).toBe(200);
        const events: { type: string; delta?: string }[] = response.body
          .trim()
          .split(/\r?\n\r?\n/)
          .map((frame) =>
            JSON.parse(
              frame
                .split("\n")
                .find((line) => line.startsWith("data: "))!
                .slice(6),
            ),
          );
        expect(
          events
            .filter((event) => event.type === "response.function_call_arguments.delta")
            .map((event) => event.delta)
            .join(""),
        ).toBe(args.slice(0, Math.floor(args.length * 0.5)));
        expect(events.filter((event) => event.type === "response.incomplete")).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({
          type: "response.incomplete",
          response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
        });
      }
    } finally {
      await stopDriftServer(server);
    }
  });
}

test("raw per-server namespace avoids positioned values already present in the collection", async () => {
  const positioned: Fixture = { match: {}, response: { content: "old" } };
  const first = await createServer([positioned], { port: 0 });
  await stopDriftServer(first);
  const saved = getFixtureMisbehaviorPosition(positioned);
  const fresh: Fixture = { match: {}, response: { content: "new" } };
  const second = await createServer([fresh, positioned], { port: 0 });
  try {
    expect(saved).toBeTruthy();
    expect(getFixtureMisbehaviorPosition(positioned)).toBe(saved);
    expect(getFixtureMisbehaviorPosition(fresh)).toBeTruthy();
    expect(getFixtureMisbehaviorPosition(fresh)).not.toBe(saved);
  } finally {
    await stopDriftServer(second);
  }
});

test("initial malformed raw configuration starts successfully and fails only at request time", async () => {
  const fixture: Fixture = {
    match: {},
    response: { content: "ordinary" },
    misbehavior: JSON.parse('{"faults":"bad"}'),
  };
  const server = await createServer([fixture], { port: 0 });
  try {
    const result = await httpPost(`${server.url}/v1/chat/completions`, {
      ...request,
      stream: false,
    });
    expect(result.status).toBe(501);
    expect(JSON.parse(result.body).error.code).toBe("aimock_misbehavior_not_applicable");
    expect(server.journal.getAll()).toHaveLength(1);
  } finally {
    await stopDriftServer(server);
  }
});

test("OpenRouter fallback positions a fresh raw fixture appended during an awaited candidate", async () => {
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const calls: string[] = [];
  let positionAtFactory: string | undefined;
  const first: Fixture = {
    match: { model: "primary/fail" },
    response: async () => {
      calls.push("first-start");
      firstEntered.resolve();
      await releaseFirst.promise;
      calls.push("first-end");
      return { error: { message: "try fallback" }, status: 503 };
    },
  };
  const fallback: Fixture = {
    ...faultFixture(),
    match: { model: "fallback/good" },
    response: () => {
      calls.push("fallback");
      positionAtFactory = getFixtureMisbehaviorPosition(fallback);
      return { toolCalls: [{ name: "record_text", arguments: args }] };
    },
  };
  const fixtures = [first];
  const server = await createServer(fixtures, { port: 0, chunkSize: 4 });
  try {
    const pending = httpPost(`${server.url}/api/v1/chat/completions`, {
      ...request,
      model: "primary/fail",
      models: ["fallback/good"],
    });
    await firstEntered.promise;
    expect(calls).toEqual(["first-start"]);
    fixtures.push(fallback);
    releaseFirst.resolve();
    const response = await pending;
    console.log(
      JSON.stringify({ cell: "awaited-fallback", calls, positionAtFactory, ...response }),
    );
    expect(response.status).toBe(200);
    expect(positionAtFactory).toBeTruthy();
    expect(calls).toEqual(["first-start", "first-end", "fallback"]);
    assertCutStream(response.body);
    expect(fixtures[0]).toBe(first);
    expect(fixtures[1]).toBe(fallback);
    expect(server.journal.getAll()).toHaveLength(1);
    expect(server.journal.getFixtureMatchCount(first)).toBe(1);
    expect(server.journal.getFixtureMatchCount(fallback)).toBe(1);
  } finally {
    releaseFirst.resolve();
    await stopDriftServer(server);
  }
});
