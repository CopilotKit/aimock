import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { Fixture } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// --- helpers ---

function post(
  url: string,
  body: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
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
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function parseGeminiSSEChunks(body: string): unknown[] {
  const chunks: unknown[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      chunks.push(JSON.parse(line.slice(6)));
    }
  }
  return chunks;
}

// --- fixtures ---

const textFixture: Fixture = {
  match: { userMessage: "hello" },
  response: { content: "Hi there!" },
};

const toolFixture: Fixture = {
  match: { userMessage: "weather" },
  response: {
    toolCalls: [
      {
        name: "get_weather",
        arguments: '{"city":"NYC"}',
      },
    ],
  },
};

// --- tests ---

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

const VERTEX_BASE = "/v1/projects/my-project/locations/us-central1/publishers/google/models";

function vertexUrl(base: string, model: string, action: string): string {
  return `${base}${VERTEX_BASE}/${model}:${action}`;
}

const geminiBody = (text: string) => ({
  contents: [{ role: "user", parts: [{ text }] }],
});

// ─── Non-streaming (generateContent) ────────────────────────────────────────

describe("Vertex AI: generateContent (non-streaming)", () => {
  it("routes to Gemini handler and returns correct text response", async () => {
    instance = await createServer([textFixture]);
    const res = await post(
      vertexUrl(instance.url, "gemini-2.0-flash", "generateContent"),
      geminiBody("hello"),
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(res.body);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].content.role).toBe("model");
    expect(body.candidates[0].content.parts[0].text).toBe("Hi there!");
    expect(body.candidates[0].finishReason).toBe("STOP");
    expect(body.usageMetadata).toBeDefined();
  });

  it("extracts model name from URL path and records it in journal", async () => {
    instance = await createServer([textFixture]);
    await post(vertexUrl(instance.url, "gemini-1.5-pro", "generateContent"), geminiBody("hello"));

    const entry = instance.journal.getLast();
    expect(entry).not.toBeNull();
    expect(entry!.body.model).toBe("gemini-1.5-pro");
  });

  it("returns tool call response with functionCall parts", async () => {
    instance = await createServer([toolFixture]);
    const res = await post(
      vertexUrl(instance.url, "gemini-2.0-flash", "generateContent"),
      geminiBody("weather"),
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.candidates[0].content.parts[0].functionCall).toBeDefined();
    expect(body.candidates[0].content.parts[0].functionCall.name).toBe("get_weather");
    expect(body.candidates[0].content.parts[0].functionCall.args).toEqual({ city: "NYC" });
    expect(body.candidates[0].finishReason).toBe("FUNCTION_CALL");
  });
});

// ─── Streaming (streamGenerateContent) ──────────────────────────────────────

describe("Vertex AI: streamGenerateContent (streaming)", () => {
  it("streams text response as SSE", async () => {
    instance = await createServer([textFixture]);
    const res = await post(
      vertexUrl(instance.url, "gemini-2.0-flash", "streamGenerateContent"),
      geminiBody("hello"),
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");

    const chunks = parseGeminiSSEChunks(res.body) as {
      candidates: {
        content: { role: string; parts: { text?: string }[] };
        finishReason?: string;
      }[];
      usageMetadata?: unknown;
    }[];

    expect(chunks.length).toBeGreaterThan(0);

    // Reconstruct content from text parts
    const fullText = chunks.map((c) => c.candidates[0].content.parts[0].text ?? "").join("");
    expect(fullText).toBe("Hi there!");

    // Last chunk has finishReason
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.candidates[0].finishReason).toBe("STOP");
    expect(lastChunk.usageMetadata).toBeDefined();
  });

  it("streams tool calls as SSE", async () => {
    instance = await createServer([toolFixture]);
    const res = await post(
      vertexUrl(instance.url, "gemini-2.0-flash", "streamGenerateContent"),
      geminiBody("weather"),
    );

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body) as {
      candidates: {
        content: {
          parts: { functionCall?: { name: string; args: unknown } }[];
        };
        finishReason?: string;
      }[];
    }[];

    expect(chunks).toHaveLength(1);
    expect(chunks[0].candidates[0].content.parts[0].functionCall!.name).toBe("get_weather");
    expect(chunks[0].candidates[0].finishReason).toBe("FUNCTION_CALL");
  });
});

// ─── Response format parity with consumer Gemini ────────────────────────────

describe("Vertex AI: response format matches consumer Gemini", () => {
  it("non-streaming responses are identical", async () => {
    instance = await createServer([textFixture]);

    const vertexRes = await post(
      vertexUrl(instance.url, "gemini-2.0-flash", "generateContent"),
      geminiBody("hello"),
    );
    const geminiRes = await post(
      `${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`,
      geminiBody("hello"),
    );

    const vertexBody = JSON.parse(vertexRes.body);
    const geminiBody_ = JSON.parse(geminiRes.body);

    // Structure should be identical (candidates, usageMetadata)
    expect(vertexBody.candidates[0].content).toEqual(geminiBody_.candidates[0].content);
    expect(vertexBody.candidates[0].finishReason).toEqual(geminiBody_.candidates[0].finishReason);
    expect(Object.keys(vertexBody)).toEqual(Object.keys(geminiBody_));
  });

  it("streaming responses are identical", async () => {
    instance = await createServer([textFixture]);

    const vertexRes = await post(
      vertexUrl(instance.url, "gemini-2.0-flash", "streamGenerateContent"),
      geminiBody("hello"),
    );
    const geminiRes = await post(
      `${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`,
      geminiBody("hello"),
    );

    const vertexChunks = parseGeminiSSEChunks(vertexRes.body);
    const geminiChunks = parseGeminiSSEChunks(geminiRes.body);

    expect(vertexChunks.length).toBe(geminiChunks.length);
    // Each chunk should have the same structure
    for (let i = 0; i < vertexChunks.length; i++) {
      expect(vertexChunks[i]).toEqual(geminiChunks[i]);
    }
  });
});

// ─── Tool call parity with consumer Gemini ──────────────────────────────────

describe("Vertex AI: tool call parity with consumer Gemini", () => {
  it("non-streaming tool call responses have same structure", async () => {
    instance = await createServer([toolFixture]);

    const vertexRes = await post(
      vertexUrl(instance.url, "gemini-2.0-flash", "generateContent"),
      geminiBody("weather"),
    );
    const geminiRes = await post(
      `${instance.url}/v1beta/models/gemini-2.0-flash:generateContent`,
      geminiBody("weather"),
    );

    const vertexBody = JSON.parse(vertexRes.body);
    const geminiBody_ = JSON.parse(geminiRes.body);

    // Both should have FUNCTION_CALL finish reason
    expect(vertexBody.candidates[0].finishReason).toBe("FUNCTION_CALL");
    expect(geminiBody_.candidates[0].finishReason).toBe("FUNCTION_CALL");

    // Same role
    expect(vertexBody.candidates[0].content.role).toBe(geminiBody_.candidates[0].content.role);

    // Same function name and args (IDs differ since they're randomly generated)
    const vertexFc = vertexBody.candidates[0].content.parts[0].functionCall;
    const geminiFc = geminiBody_.candidates[0].content.parts[0].functionCall;
    expect(vertexFc.name).toBe(geminiFc.name);
    expect(vertexFc.args).toEqual(geminiFc.args);

    // Same top-level keys
    expect(Object.keys(vertexBody)).toEqual(Object.keys(geminiBody_));
  });

  it("streaming tool call responses have same structure", async () => {
    instance = await createServer([toolFixture]);

    const vertexRes = await post(
      vertexUrl(instance.url, "gemini-2.0-flash", "streamGenerateContent"),
      geminiBody("weather"),
    );
    const geminiRes = await post(
      `${instance.url}/v1beta/models/gemini-2.0-flash:streamGenerateContent`,
      geminiBody("weather"),
    );

    const vertexChunks = parseGeminiSSEChunks(vertexRes.body) as Array<Record<string, unknown>>;
    const geminiChunks = parseGeminiSSEChunks(geminiRes.body) as Array<Record<string, unknown>>;

    expect(vertexChunks.length).toBe(geminiChunks.length);

    // Compare structure: same finishReason, same function name/args
    for (let i = 0; i < vertexChunks.length; i++) {
      const vc = vertexChunks[i].candidates as Array<Record<string, unknown>>;
      const gc = geminiChunks[i].candidates as Array<Record<string, unknown>>;
      expect(vc[0].finishReason).toBe(gc[0].finishReason);
      const vContent = vc[0].content as Record<string, unknown>;
      const gContent = gc[0].content as Record<string, unknown>;
      expect(vContent.role).toBe(gContent.role);
      const vParts = vContent.parts as Array<Record<string, unknown>>;
      const gParts = gContent.parts as Array<Record<string, unknown>>;
      // Same function name and args
      const vFc = vParts[0].functionCall as Record<string, unknown>;
      const gFc = gParts[0].functionCall as Record<string, unknown>;
      expect(vFc.name).toBe(gFc.name);
      expect(vFc.args).toEqual(gFc.args);
    }
  });
});

// ─── Query parameter resilience ─────────────────────────────────────────────

describe("Vertex AI: query parameter resilience", () => {
  it("?alt=sse does not break routing", async () => {
    instance = await createServer([textFixture]);
    const urlPath = `${VERTEX_BASE}/gemini-2.0-flash:streamGenerateContent`;

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const data = JSON.stringify(geminiBody("hello"));
      const parsed = new URL(instance!.url);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: `${urlPath}?alt=sse`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
            });
          });
        },
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });

    expect(res.status).toBe(200);
    const chunks = parseGeminiSSEChunks(res.body);
    const fullText = chunks
      .map(
        (c) =>
          ((c as Record<string, unknown>).candidates as Array<Record<string, unknown>>)?.[0] &&
          (
            (
              (
                (c as Record<string, unknown>).candidates as Array<Record<string, unknown>>
              )?.[0] as Record<string, unknown>
            )?.content as Record<string, unknown>
          )?.parts,
      )
      .filter(Boolean)
      .map((parts) => ((parts as Array<Record<string, unknown>>)[0]?.text as string) ?? "")
      .join("");
    expect(fullText).toBe("Hi there!");
  });
});

// ─── Various project/location combinations ──────────────────────────────────

describe("Vertex AI: various project/location combinations", () => {
  const combos = [
    { project: "my-project", location: "us-central1" },
    { project: "prod-123", location: "europe-west4" },
    { project: "test_project_456", location: "asia-east1" },
    { project: "my-org-project", location: "us-east1" },
  ];

  for (const { project, location } of combos) {
    it(`routes ${project}/${location} correctly`, async () => {
      instance = await createServer([textFixture]);
      const path = `/v1/projects/${project}/locations/${location}/publishers/google/models/gemini-2.0-flash:generateContent`;
      const res = await post(`${instance.url}${path}`, geminiBody("hello"));

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.candidates[0].content.parts[0].text).toBe("Hi there!");

      // Clean up for next iteration
      await new Promise<void>((resolve) => {
        instance!.server.close(() => resolve());
      });
      instance = null;
    });
  }
});

// ─── Malformed URL / Wrong method / Strict mode ─────────────────────────────

describe("Vertex AI: malformed URL", () => {
  it("22a. returns 404 for unknown action in URL", async () => {
    instance = await createServer([textFixture]);
    const res = await post(
      `${instance.url}/v1/projects/p/locations/l/publishers/google/models/m:unknownAction`,
      geminiBody("hello"),
    );

    expect(res.status).toBe(404);
  });
});

describe("Vertex AI: wrong HTTP method", () => {
  it("22b. returns 404 for GET to a valid Vertex AI path", async () => {
    instance = await createServer([textFixture]);
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const parsed = new URL(vertexUrl(instance!.url, "gemini-2.0-flash", "generateContent"));
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: "GET",
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(res.status).toBe(404);
  });
});

describe("Vertex AI: malformed JSON body", () => {
  it("returns 400 for non-JSON body", async () => {
    instance = await createServer([textFixture]);
    const parsed = new URL(vertexUrl(instance.url, "gemini-2.0-flash", "generateContent"));
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const raw = "not json";
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(raw),
          },
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => {
            resolve({
              status: r.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
            });
          });
        },
      );
      req.on("error", reject);
      req.write(raw);
      req.end();
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Malformed JSON");
  });
});

describe("Vertex AI: strict mode", () => {
  it("22c. returns 503 in strict mode with no fixtures", async () => {
    instance = await createServer([], { strict: true });
    const res = await post(
      vertexUrl(instance.url, "gemini-2.0-flash", "generateContent"),
      geminiBody("hello"),
    );

    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("no fixture matched");
  });
});

// ─── Chaos ──────────────────────────────────────────────────────────────────

describe("Vertex AI: chaos applies", () => {
  it("drops request when dropRate is 1.0", async () => {
    instance = await createServer([textFixture], { chaos: { dropRate: 1.0 } });
    const res = await post(
      vertexUrl(instance.url, "gemini-2.0-flash", "generateContent"),
      geminiBody("hello"),
    );

    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("chaos_drop");
  });

  it("records chaos action in journal", async () => {
    instance = await createServer([textFixture], { chaos: { dropRate: 1.0 } });
    await post(vertexUrl(instance.url, "gemini-2.0-flash", "generateContent"), geminiBody("hello"));

    const entries = instance.journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].response.chaosAction).toBe("drop");
  });
});
