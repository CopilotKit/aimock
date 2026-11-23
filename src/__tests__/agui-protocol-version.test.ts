import { expect, it } from "vitest";
import { AGUIMock, type AGUIRunStartedEvent } from "../agui-stub.js";

it.each([undefined, "1.0"])(
  "preserves optional RUN_STARTED protocolVersion=%s on the public stream",
  async (protocolVersion) => {
    const started: AGUIRunStartedEvent = {
      type: "RUN_STARTED",
      threadId: "t",
      runId: "r",
      timestamp: 123,
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
    };
    // Compile-time public contract: callers can inspect this declared optional field.
    const declared: string | undefined = started.protocolVersion;
    expect(declared).toBe(protocolVersion);
    const mock = new AGUIMock({ port: 0 });
    mock.addFixture({
      match: { message: "version" },
      events: [started, { type: "RUN_FINISHED", threadId: "t", runId: "r" }],
    });
    try {
      await mock.start();
      const response = await fetch(mock.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "t",
          runId: "r",
          messages: [{ id: "m", role: "user", content: "version" }],
          tools: [],
          context: [],
          state: {},
        }),
      });
      expect(response.status).toBe(200);
      const first = (await response.text()).split("\n\n").find((line) => line.startsWith("data: "));
      expect(first).toBeDefined();
      expect(JSON.parse(first!.slice(6))).toEqual(started);
    } finally {
      await mock.stop();
    }
  },
);
