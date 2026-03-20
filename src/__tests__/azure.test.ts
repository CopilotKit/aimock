import { describe, it, expect, afterEach } from "vitest";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function httpPost(
  url: string,
  body: object,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
    instance = null;
  }
});

// ---------------------------------------------------------------------------
// Azure OpenAI deployment URL routing
// ---------------------------------------------------------------------------

describe("Azure OpenAI: chat completions via deployment URL", () => {
  it("routes /openai/deployments/{id}/chat/completions to completions handler", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Azure says hi!" },
      },
    ];
    instance = await createServer(fixtures);

    const { status, body } = await httpPost(
      `${instance.url}/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21`,
      {
        model: "gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
    );

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.choices).toBeDefined();
    expect(parsed.choices[0].message.content).toBe("Azure says hi!");
    expect(parsed.object).toBe("chat.completion");
  });

  it("uses deployment ID as model fallback when body omits model", async () => {
    const fixtures: Fixture[] = [
      {
        match: { model: "my-gpt4-deployment", userMessage: "hello" },
        response: { content: "Matched by deployment ID!" },
      },
    ];
    instance = await createServer(fixtures);

    const { status, body } = await httpPost(
      `${instance.url}/openai/deployments/my-gpt4-deployment/chat/completions?api-version=2024-10-21`,
      {
        // No model field — Azure deployments often omit it
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
    );

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.choices[0].message.content).toBe("Matched by deployment ID!");
  });

  it("body model takes precedence over deployment ID", async () => {
    const fixtures: Fixture[] = [
      {
        match: { model: "gpt-4o", userMessage: "hello" },
        response: { content: "Matched body model!" },
      },
      {
        match: { model: "my-deployment", userMessage: "hello" },
        response: { content: "Matched deployment ID!" },
      },
    ];
    instance = await createServer(fixtures);

    const { status, body } = await httpPost(
      `${instance.url}/openai/deployments/my-deployment/chat/completions?api-version=2024-10-21`,
      {
        model: "gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
    );

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.choices[0].message.content).toBe("Matched body model!");
  });
});

describe("Azure OpenAI: embeddings via deployment URL", () => {
  it("routes /openai/deployments/{id}/embeddings to embeddings handler", async () => {
    instance = await createServer([]);

    const { status, body } = await httpPost(
      `${instance.url}/openai/deployments/text-embedding-ada-002/embeddings?api-version=2024-10-21`,
      {
        model: "text-embedding-ada-002",
        input: "hello world",
      },
    );

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.object).toBe("list");
    expect(parsed.data[0].embedding).toBeInstanceOf(Array);
    expect(parsed.data[0].embedding.length).toBeGreaterThan(0);
  });

  it("uses deployment ID as model fallback for embeddings when body omits model", async () => {
    instance = await createServer([]);

    const { status, body } = await httpPost(
      `${instance.url}/openai/deployments/text-embedding-ada-002/embeddings?api-version=2024-10-21`,
      {
        // No model field
        input: "hello world",
      },
    );

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.object).toBe("list");
    expect(parsed.model).toBe("text-embedding-ada-002");
  });
});

describe("Azure OpenAI: api-version query param", () => {
  it("accepts any api-version value", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Works!" },
      },
    ];
    instance = await createServer(fixtures);

    const { status } = await httpPost(
      `${instance.url}/openai/deployments/gpt-4o/chat/completions?api-version=2023-05-15`,
      {
        model: "gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
    );

    expect(status).toBe(200);
  });

  it("works without api-version param", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Works!" },
      },
    ];
    instance = await createServer(fixtures);

    const { status } = await httpPost(
      `${instance.url}/openai/deployments/gpt-4o/chat/completions`,
      {
        model: "gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
    );

    expect(status).toBe(200);
  });
});

describe("Azure OpenAI: api-key header", () => {
  it("accepts api-key header (Azure-style auth)", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Authenticated!" },
      },
    ];
    instance = await createServer(fixtures);

    const { status, body } = await httpPost(
      `${instance.url}/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21`,
      {
        model: "gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
      { "api-key": "mock-azure-key" },
    );

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.choices[0].message.content).toBe("Authenticated!");
  });

  it("accepts Authorization Bearer header (also valid for Azure)", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "hello" },
        response: { content: "Bearer works!" },
      },
    ];
    instance = await createServer(fixtures);

    const { status, body } = await httpPost(
      `${instance.url}/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21`,
      {
        model: "gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
      { Authorization: "Bearer mock-token" },
    );

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.choices[0].message.content).toBe("Bearer works!");
  });
});

describe("Azure OpenAI: journal recording", () => {
  it("records Azure deployment requests in journal", async () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "journal-test" },
        response: { content: "Recorded!" },
      },
    ];
    instance = await createServer(fixtures);

    await httpPost(
      `${instance.url}/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21`,
      {
        model: "gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "journal-test" }],
      },
    );

    expect(instance.journal.size).toBe(1);
    const entry = instance.journal.getLast();
    expect(entry).toBeDefined();
    expect(entry!.method).toBe("POST");
    expect(entry!.response.status).toBe(200);
  });
});

describe("Azure OpenAI: 404 when no fixture matches", () => {
  it("returns 404 when no fixture matches the request", async () => {
    const fixtures: Fixture[] = [
      {
        match: { model: "specific-model", userMessage: "specific" },
        response: { content: "Specific!" },
      },
    ];
    instance = await createServer(fixtures);

    const { status, body } = await httpPost(
      `${instance.url}/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21`,
      {
        model: "gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "no match here" }],
      },
    );

    expect(status).toBe(404);
    const parsed = JSON.parse(body);
    expect(parsed.error.code).toBe("no_fixture_match");
  });
});
