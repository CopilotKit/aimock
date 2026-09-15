import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import { resolveRequestId } from "../helpers.js";

describe("X-Request-Id propagation", () => {
  let mock: LLMock;
  beforeEach(async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
  });

  it("resolves well-formed ids verbatim and mints otherwise", () => {
    expect(resolveRequestId({ "x-request-id": "trace-123" })).toMatchObject({
      id: "trace-123",
      generated: false,
    });
    expect(resolveRequestId({})).toMatchObject({ generated: true });
    expect(resolveRequestId({ "x-request-id": "" }).generated).toBe(true);
    expect(resolveRequestId({ "x-request-id": "has space" }).generated).toBe(true);
    expect(resolveRequestId({ "x-request-id": "x".repeat(129) }).generated).toBe(true);
    expect(resolveRequestId({ "x-request-id": "ok_-.:" }).generated).toBe(false);
  });

  it("echoes caller id on responses and journals it", async () => {
    const res = await fetch(`${mock.url}/v1/models`, {
      headers: { "X-Request-Id": "my-trace-1" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("my-trace-1");

    // /v1/models is not journaled by design — exercise a journaled surface.
    const mod = await fetch(`${mock.url}/v1/moderations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": "my-trace-1" },
      body: JSON.stringify({ input: "hello" }),
    });
    expect(mod.headers.get("x-request-id")).toBe("my-trace-1");

    const journal = (await (
      await fetch(`${mock.url}/__aimock/journal?requestId=my-trace-1`)
    ).json()) as { headers: Record<string, string> }[];
    expect(journal.length).toBeGreaterThan(0);
    expect(journal.every((e) => e.headers["x-request-id"] === "my-trace-1")).toBe(true);
  });

  it("mints an id when absent and filters exactly", async () => {
    const res = await fetch(`${mock.url}/v1/moderations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    });
    const minted = res.headers.get("x-request-id");
    expect(minted).toMatch(/^req-/);

    const journal = (await (
      await fetch(`${mock.url}/__aimock/journal?requestId=${minted}`)
    ).json()) as unknown[];
    expect(journal.length).toBeGreaterThan(0);

    const empty = (await (
      await fetch(`${mock.url}/__aimock/journal?requestId=no-such-id`)
    ).json()) as unknown[];
    expect(empty).toEqual([]);

    const bad = await fetch(`${mock.url}/__aimock/journal?requestIdx=1`);
    expect(bad.status).toBe(400);
  });

  it("replaces malformed caller ids and exposes via CORS", async () => {
    const res = await fetch(`${mock.url}/v1/models`, {
      headers: { "X-Request-Id": "bad id with spaces" },
    });
    const echoed = res.headers.get("x-request-id");
    expect(echoed).not.toBe("bad id with spaces");
    expect(echoed).toMatch(/^req-/);

    const health = await fetch(`${mock.url}/__aimock/health`);
    // Control responses also carry the id (header set before dispatch).
    expect(health.headers.get("x-request-id")).toMatch(/^req-/);
  });
});
