import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import { clearThreadsStore } from "../threads.js";
import { normalizePathLabel } from "../metrics.js";

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Threads subset mock", () => {
  let mock: LLMock;
  beforeEach(async () => {
    clearThreadsStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
    clearThreadsStore();
  });

  it("creates a thread, posts/list messages, runs to completed, deletes", async () => {
    const thread = (await (await post(`${mock.url}/v1/threads`, {})).json()) as { id: string };
    expect(thread.id.startsWith("thread-")).toBe(true);

    const msg = (await (
      await post(`${mock.url}/v1/threads/${thread.id}/messages`, {
        role: "user",
        content: "hello",
      })
    ).json()) as { id: string; content: { text: { value: string } }[] };
    expect(msg.content[0].text.value).toBe("hello");

    const listed = (await (await fetch(`${mock.url}/v1/threads/${thread.id}/messages`)).json()) as {
      data: { id: string }[];
    };
    expect(listed.data.map((d) => d.id)).toContain(msg.id);

    const run = (await (
      await post(`${mock.url}/v1/threads/${thread.id}/runs`, { assistant_id: "asst-1" })
    ).json()) as { id: string; status: string };
    expect(run.status).toBe("queued");

    const p1 = (await (
      await fetch(`${mock.url}/v1/threads/${thread.id}/runs/${run.id}`)
    ).json()) as {
      status: string;
    };
    expect(p1.status).toBe("in_progress");
    const p2 = (await (
      await fetch(`${mock.url}/v1/threads/${thread.id}/runs/${run.id}`)
    ).json()) as {
      status: string;
    };
    expect(p2.status).toBe("completed");

    expect((await fetch(`${mock.url}/v1/threads/${thread.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    expect((await fetch(`${mock.url}/v1/threads/${thread.id}`)).status).toBe(404);
  });

  it("validates inputs, journals, resets, normalizes", async () => {
    expect(
      (await post(`${mock.url}/v1/threads/thread-nope/messages`, { role: "user", content: "x" }))
        .status,
    ).toBe(404);
    const thread = (await (await post(`${mock.url}/v1/threads`, {})).json()) as { id: string };
    expect(
      (await post(`${mock.url}/v1/threads/${thread.id}/messages`, { role: "user" })).status,
    ).toBe(400);
    expect((await post(`${mock.url}/v1/threads/${thread.id}/runs`, {})).status).toBe(400);

    const journal = (await (
      await fetch(`${mock.url}/__aimock/journal?service=threads`)
    ).json()) as unknown[];
    expect(journal.length).toBeGreaterThan(0);
    await fetch(`${mock.url}/__aimock/reset`, { method: "POST" });
    expect((await fetch(`${mock.url}/v1/threads/${thread.id}`)).status).toBe(404);
    expect(normalizePathLabel("/v1/threads")).toBe("/v1/threads");
    expect(normalizePathLabel("/v1/threads/thread-1")).toBe("/v1/threads/{id}");
    expect(normalizePathLabel("/v1/threads/thread-1/messages")).toBe("/v1/threads/{id}/messages");
    expect(normalizePathLabel("/v1/threads/thread-1/runs")).toBe("/v1/threads/{id}/runs");
    expect(normalizePathLabel("/v1/threads/thread-1/runs/run-1")).toBe(
      "/v1/threads/{id}/runs/{runId}",
    );
  });
});
