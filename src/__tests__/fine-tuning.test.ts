import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import { clearFineTuningStore } from "../fine-tuning.js";
import { normalizePathLabel } from "../metrics.js";

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Fine-tuning mock", () => {
  let mock: LLMock;
  beforeEach(async () => {
    clearFineTuningStore();
    mock = new LLMock({ port: 0 });
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
    clearFineTuningStore();
  });

  it("creates and advances to succeeded with a fine-tuned model", async () => {
    const created = (await (
      await post(`${mock.url}/v1/fine_tuning/jobs`, {
        training_file: "file-train",
        model: "gpt-4o-mini",
      })
    ).json()) as { id: string; status: string };
    expect(created.status).toBe("validating_files");
    expect(
      (await (await fetch(`${mock.url}/v1/fine_tuning/jobs/${created.id}`)).json()) as {
        status: string;
      },
    ).toMatchObject({ status: "queued" });
    expect(
      (await (await fetch(`${mock.url}/v1/fine_tuning/jobs/${created.id}`)).json()) as {
        status: string;
      },
    ).toMatchObject({ status: "running" });
    const done = (await (await fetch(`${mock.url}/v1/fine_tuning/jobs/${created.id}`)).json()) as {
      status: string;
      fine_tuned_model: string;
    };
    expect(done.status).toBe("succeeded");
    expect(done.fine_tuned_model.startsWith("ft:gpt-4o-mini")).toBe(true);

    const events = (await (
      await fetch(`${mock.url}/v1/fine_tuning/jobs/${created.id}/events`)
    ).json()) as { object: string; data: { message: string }[] };
    expect(events.object).toBe("list");
    expect(events.data.length).toBeGreaterThanOrEqual(4);
  });

  it("lists, cancels, validates, journals and normalizes", async () => {
    const a = (await (
      await post(`${mock.url}/v1/fine_tuning/jobs`, { training_file: "f1", model: "gpt-4o" })
    ).json()) as { id: string };
    const b = (await (
      await post(`${mock.url}/v1/fine_tuning/jobs`, { training_file: "f2", model: "gpt-4o" })
    ).json()) as { id: string };
    const list = (await (await fetch(`${mock.url}/v1/fine_tuning/jobs`)).json()) as {
      data: { id: string }[];
    };
    expect(list.data.map((d) => d.id)).toEqual(expect.arrayContaining([a.id, b.id]));

    const cancelled = (await (
      await post(`${mock.url}/v1/fine_tuning/jobs/${a.id}/cancel`, {})
    ).json()) as {
      status: string;
    };
    expect(cancelled.status).toBe("cancelled");

    expect((await post(`${mock.url}/v1/fine_tuning/jobs`, { model: "gpt-4o" })).status).toBe(400);
    expect((await post(`${mock.url}/v1/fine_tuning/jobs`, { training_file: "f" })).status).toBe(
      400,
    );
    expect((await fetch(`${mock.url}/v1/fine_tuning/jobs/ftjob-nope`)).status).toBe(404);

    const journal = (await (
      await fetch(`${mock.url}/__aimock/journal?service=fine-tuning`)
    ).json()) as unknown[];
    expect(journal.length).toBeGreaterThan(0);
    await fetch(`${mock.url}/__aimock/reset`, { method: "POST" });
    expect(
      ((await (await fetch(`${mock.url}/v1/fine_tuning/jobs`)).json()) as { data: unknown[] }).data,
    ).toEqual([]);
    expect(normalizePathLabel("/v1/fine_tuning/jobs")).toBe("/v1/fine_tuning/jobs");
    expect(normalizePathLabel("/v1/fine_tuning/jobs/ftjob-1")).toBe("/v1/fine_tuning/jobs/{id}");
    expect(normalizePathLabel("/v1/fine_tuning/jobs/ftjob-1/cancel")).toBe(
      "/v1/fine_tuning/jobs/{id}/cancel",
    );
    expect(normalizePathLabel("/v1/fine_tuning/jobs/ftjob-1/events")).toBe(
      "/v1/fine_tuning/jobs/{id}/events",
    );
  });
});
