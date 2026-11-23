import { expect, test } from "vitest";
import type { MisbehaviorFault } from "../../types.js";
import { withFaultFixture } from "../helpers/misbehavior-server.js";
import { connectWebSocket } from "../ws-test-client.js";
import { collectMockWSMessages } from "./helpers.js";
import {
  buildResponsesCreateMessage,
  isResponsesWSTerminal,
  extractWSErrorBody,
} from "./ws-providers.js";

const faults: MisbehaviorFault[] = [
  { fault: "stop-length-mid-tool" },
  { fault: "reasoning-only", reasoning: "Considering options" },
  { fault: "content-filter" },
];

test.each(faults)("collects the actual $fault incomplete terminal", async (fault) => {
  await withFaultFixture({ faults: [fault] }, async ({ mock, url }) => {
    const ws = await connectWebSocket(url, "/v1/responses");
    try {
      ws.send(
        JSON.stringify(
          buildResponsesCreateMessage("gpt-4o", [{ role: "user", content: "weather" }]),
        ),
      );
      let result: Awaited<ReturnType<typeof collectMockWSMessages>> | undefined;
      let failure: unknown;
      try {
        result = await collectMockWSMessages(ws, isResponsesWSTerminal, 1000);
      } catch (error) {
        failure = error;
      }
      const received = ws.getMessages().map(
        (
          raw,
        ): {
          type: string;
          response?: { status: string; incomplete_details?: { reason: string } };
        } => JSON.parse(raw),
      );
      console.log(
        JSON.stringify({
          fault,
          received,
          journal: mock.getRequests(),
          collectorError: failure instanceof Error ? failure.message : null,
        }),
      );
      expect(received.at(-1)).toMatchObject({
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: {
            reason: fault.fault === "content-filter" ? "content_filter" : "max_output_tokens",
          },
        },
      });
      expect(mock.getRequests()).toHaveLength(1);
      expect(mock.getRequests()[0].response.misbehavior).toMatchObject({
        applied: true,
        fault: fault.fault,
      });
      expect(failure).toBeUndefined();
      expect(result?.rawMessages).toEqual(received);
      expect(received.length).toBeGreaterThan(2);
      expect(received.slice(0, -1).every((event) => !isResponsesWSTerminal(event))).toBe(true);
      expect(extractWSErrorBody(result!.rawMessages)).toBeNull();
    } finally {
      ws.close();
      await ws.waitForClose();
      ws.destroy();
    }
  });
});

test("preserves completed and native error collection on the same real session", async () => {
  await withFaultFixture(undefined, async ({ mock, url }) => {
    const ws = await connectWebSocket(url, "/v1/responses");
    try {
      ws.send(
        JSON.stringify(
          buildResponsesCreateMessage("gpt-4o", [{ role: "user", content: "weather" }]),
        ),
      );
      const completed = await collectMockWSMessages(ws, isResponsesWSTerminal, 1000);
      expect(completed.events.at(-1)?.type).toBe("response.completed");
      expect(extractWSErrorBody(completed.rawMessages)).toBeNull();
      ws.send(
        JSON.stringify(
          buildResponsesCreateMessage("gpt-4o", [{ role: "user", content: "unmatched" }]),
        ),
      );
      const error = await collectMockWSMessages(
        ws,
        isResponsesWSTerminal,
        1000,
        completed.rawMessages.length,
      );
      expect(error.events).toHaveLength(1);
      expect(error.events[0].type).toBe("error");
      expect(extractWSErrorBody(error.rawMessages)).toContain("No fixture matched");
      console.log(
        JSON.stringify({
          control: "completed-then-error",
          completed: completed.rawMessages,
          error: error.rawMessages,
          journal: mock.getRequests(),
        }),
      );
    } finally {
      ws.close();
      await ws.waitForClose();
      ws.destroy();
    }
  });
});
