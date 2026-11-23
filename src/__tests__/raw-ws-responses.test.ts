import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMock as PlainLLMock } from "../llmock.js";
import { LLMock } from "./helpers/misbehavior-enabled.js";
import { connectWebSocket, type WSTestClient } from "./ws-test-client.js";

// WebSocket Responses (#549 T7, spec Decision 12): raw fixtures are not served
// over WS yet. A raw openai-responses fixture gets a clear error event and a
// 500 journal entry instead of the generic unknown-type error.

const RAW_WS_ERROR = "raw fixtures are not yet supported on the WebSocket transport";
const RAW_MODE_UNAVAILABLE = "aimock_raw_mode_unavailable";

let mock: PlainLLMock | undefined;
let ws: WSTestClient | undefined;
afterEach(async () => {
  if (ws) {
    ws.close();
    await ws.waitForClose();
    ws.destroy();
  }
  ws = undefined;
  await mock?.stop();
  mock = undefined;
  vi.restoreAllMocks();
});

async function firstEvent(input: string): Promise<Record<string, unknown>> {
  if (!mock) throw new Error("mock not started");
  ws = await connectWebSocket(mock.url, "/v1/responses");
  ws.send(JSON.stringify({ type: "response.create", model: "gpt-4.1", input }));
  const [message] = await ws.waitForMessages(1);
  return JSON.parse(message);
}

function addRaw(target: PlainLLMock) {
  target.addFixture({
    match: { userMessage: "raw-ws" },
    response: { raw: { wire: "openai-responses", events: [{ type: "response.created" }] } },
  });
}

describe("raw fixtures over WebSocket Responses", () => {
  it("sends a clear server_error event and journals a 500", async () => {
    mock = new PlainLLMock({ port: 0, host: "127.0.0.1", logLevel: "silent" });
    addRaw(mock);
    await mock.start();
    const event = await firstEvent("raw-ws");
    expect(event).toEqual({
      type: "error",
      error: { message: RAW_WS_ERROR, type: "server_error", code: RAW_MODE_UNAVAILABLE },
    });
    const entries = mock.getRequests();
    expect(entries).toHaveLength(1);
    expect(entries[0].response.status).toBe(500);
    expect(entries[0].response.fixture).toBe(mock.getFixtures()[0]);
    expect(entries[0].response.error).toBe(RAW_WS_ERROR);
  });

  it("logs the raw WS error with its code", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mock = new PlainLLMock({ port: 0, host: "127.0.0.1", logLevel: "warn" });
    addRaw(mock);
    await mock.start();
    const event = await firstEvent("raw-ws");
    expect(event).toMatchObject({ error: { code: RAW_MODE_UNAVAILABLE } });
    const logged = error.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain(RAW_MODE_UNAVAILABLE);
    expect(logged).toContain(RAW_WS_ERROR);
  });

  it("records the skipped misbehavior outcome under a server-level fault", async () => {
    const withFaults = new LLMock({
      port: 0,
      host: "127.0.0.1",
      logLevel: "silent",
      misbehavior: { faults: [{ fault: "empty-response", rate: 1 }] },
    });
    mock = withFaults;
    addRaw(withFaults);
    await withFaults.start();
    const event = await firstEvent("raw-ws");
    expect(event).toMatchObject({ type: "error", error: { message: RAW_WS_ERROR } });
    const [entry] = withFaults.getRequests();
    expect(entry.response.status).toBe(500);
    expect(entry.response.misbehavior).toMatchObject({
      applied: false,
      source: "server",
      wire: "openai-responses",
      evaluations: [{ fault: "empty-response", outcome: "skipped", reason: "not-applicable" }],
    });
  });

  it("a turnIndex fixture still matches as before (no record match options on WS)", async () => {
    const warn = vi.spyOn(console, "warn");
    mock = new PlainLLMock({ port: 0, host: "127.0.0.1", logLevel: "warn" });
    mock.addFixture({
      match: { userMessage: "turn", turnIndex: 3 },
      response: { content: "turn reply" },
    });
    await mock.start();
    const event = await firstEvent("turn");
    expect(event.type).toBe("response.created");
    expect(mock.getRequests()[0].response.status).toBe(200);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/turnIndex/);
  });
});
