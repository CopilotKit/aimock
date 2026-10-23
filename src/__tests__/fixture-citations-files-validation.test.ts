/**
 * Fixture `citations` and `files` are checked when a request is served, on
 * every wire that reads them (Chat Completions, Anthropic Messages, Gemini and
 * the OpenAI Responses API), streaming and non-streaming:
 * - `files` must be an array of `{ mimeType, data }` string pairs;
 * - `citations` must be an array of citation objects. A URL citation has a
 *   non-empty string `url`, an optional string `title` and optional integer
 *   offsets that satisfy `0 <= startIndex <= endIndex <= text.length`. A file
 *   citation (`type: "file"`) has a non-empty string `fileId` and `filename`
 *   and an optional integer `index` with `0 <= index <= text.length`; it needs
 *   no `url`.
 *
 * An invalid value is a coded 500 in the wire's error envelope
 * (`aimock_invalid_fixture_file` / `aimock_invalid_fixture_citation`) whose
 * message says what is wrong and how to fix the fixture, before any content is
 * written. Valid fixtures are served as before. Registration does not throw.
 *
 * Real surface: a real LLMock over HTTP.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LLMock } from "../llmock.js";
import type { Fixture, FixtureResponse } from "../types.js";
import { validateFixtures } from "../fixture-loader.js";

const TEXT = "Hello world.";

type Shape = "openai" | "messages" | "google";

interface Route {
  name: string;
  path: string;
  body: Record<string, unknown>;
  shape: Shape;
}

const chatBody = { model: "gpt-4o", messages: [{ role: "user", content: "go" }] };
const messagesBody = {
  model: "claude-sonnet-4-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "go" }],
};
const geminiBody = { contents: [{ role: "user", parts: [{ text: "go" }] }] };
const responsesBody = { model: "gpt-4o", input: "go" };

const routes: Route[] = [
  { name: "Chat", path: "/v1/chat/completions", body: chatBody, shape: "openai" },
  {
    name: "Chat stream",
    path: "/v1/chat/completions",
    body: { ...chatBody, stream: true },
    shape: "openai",
  },
  { name: "Anthropic", path: "/v1/messages", body: messagesBody, shape: "messages" },
  {
    name: "Anthropic stream",
    path: "/v1/messages",
    body: { ...messagesBody, stream: true },
    shape: "messages",
  },
  {
    name: "Gemini",
    path: "/v1beta/models/gemini-2.0-flash:generateContent",
    body: geminiBody,
    shape: "google",
  },
  {
    name: "Gemini stream",
    path: "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
    body: geminiBody,
    shape: "google",
  },
  { name: "Responses", path: "/v1/responses", body: responsesBody, shape: "openai" },
  {
    name: "Responses stream",
    path: "/v1/responses",
    body: { ...responsesBody, stream: true },
    shape: "openai",
  },
];

interface BadCase {
  id: string;
  response: Record<string, unknown>;
  code: "aimock_invalid_fixture_file" | "aimock_invalid_fixture_citation";
  /** Fragments the error message must contain: what is wrong and how to fix it. */
  says: string[];
}

const png = { mimeType: "image/png", data: "iVBORw0KGgo=" };

const badCases: BadCase[] = [
  {
    id: "files is an object",
    response: { content: TEXT, files: png },
    code: "aimock_invalid_fixture_file",
    says: ['"files" must be an array', "got an object", "wrap a single file in [ ]"],
  },
  {
    id: "files is a string",
    response: { content: TEXT, files: "iVBORw0KGgo=" },
    code: "aimock_invalid_fixture_file",
    says: ['"files" must be an array', "got a string"],
  },
  {
    id: "a file without mimeType",
    response: { content: TEXT, files: [{ data: "iVBORw0KGgo=" }] },
    code: "aimock_invalid_fixture_file",
    says: ["files[0].mimeType must be a non-empty string", "got undefined"],
  },
  {
    id: "a file with an empty mimeType",
    response: { content: TEXT, files: [{ mimeType: "", data: "iVBORw0KGgo=" }] },
    code: "aimock_invalid_fixture_file",
    says: ["files[0].mimeType must be a non-empty string", 'got ""'],
  },
  {
    id: "a file that is not an object",
    response: { content: TEXT, files: ["iVBORw0KGgo="] },
    code: "aimock_invalid_fixture_file",
    says: ["files[0] must be a { mimeType, data } object", 'got "iVBORw0KGgo="'],
  },
  {
    id: "a file that is null",
    response: { content: TEXT, files: [null] },
    code: "aimock_invalid_fixture_file",
    says: ["files[0] must be a { mimeType, data } object", "got null"],
  },
  {
    id: "a file that is an array",
    response: { content: TEXT, files: [["image/png", "iVBORw0KGgo="]] },
    code: "aimock_invalid_fixture_file",
    says: ["files[0] must be a { mimeType, data } object", "got an array"],
  },
  {
    id: "a file with non-string data",
    response: { content: TEXT, files: [{ mimeType: "image/png", data: 42 }] },
    code: "aimock_invalid_fixture_file",
    says: ["files[0].data must be a string", "got 42", "set the base64-encoded file bytes"],
  },
  {
    id: "a file without data",
    response: { content: TEXT, files: [{ mimeType: "image/png" }] },
    code: "aimock_invalid_fixture_file",
    says: ["files[0].data must be a string", "got undefined"],
  },
  {
    id: "citations is an object",
    response: { content: TEXT, citations: { url: "https://example.com" } },
    code: "aimock_invalid_fixture_citation",
    says: ['"citations" must be an array', "got an object"],
  },
  {
    id: "a citation that is a string",
    response: { content: TEXT, citations: ["https://example.com"] },
    code: "aimock_invalid_fixture_citation",
    says: [
      "citations[0] must be a { url, title?, startIndex?, endIndex? }",
      'got "https://example.com"',
    ],
  },
  {
    id: "a citation that is null",
    response: { content: TEXT, citations: [null] },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0] must be a { url, title?, startIndex?, endIndex? }", "got null"],
  },
  {
    id: "a citation that is an array",
    response: { content: TEXT, citations: [["https://example.com"]] },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0] must be a { url, title?, startIndex?, endIndex? }", "got an array"],
  },
  {
    id: "a non-string title",
    response: { content: TEXT, citations: [{ url: "https://example.com", title: 7 }] },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0].title must be a string when set", "got 7"],
  },
  {
    id: "a non-integer endIndex",
    response: { content: TEXT, citations: [{ url: "https://example.com", endIndex: 2.5 }] },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0].endIndex must be an integer when set", "got 2.5"],
  },
  {
    id: "a citation without url",
    response: { content: TEXT, citations: [{ title: "Example" }] },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0].url must be a non-empty string", "got undefined"],
  },
  {
    id: "a non-numeric offset",
    response: { content: TEXT, citations: [{ url: "https://example.com", startIndex: "0" }] },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0].startIndex must be an integer", 'got "0"'],
  },
  {
    id: "inverted offsets",
    response: {
      content: TEXT,
      citations: [{ url: "https://example.com", startIndex: 5, endIndex: 2 }],
    },
    code: "aimock_invalid_fixture_citation",
    says: [
      "citations[0] offsets must satisfy 0 <= startIndex <= endIndex <= text length (12)",
      "got startIndex 5, endIndex 2",
    ],
  },
  {
    id: "an out-of-range endIndex",
    response: { content: TEXT, citations: [{ url: "https://example.com", endIndex: 99 }] },
    code: "aimock_invalid_fixture_citation",
    says: ["text length (12)", "got startIndex 0, endIndex 99"],
  },
  {
    id: "a negative startIndex",
    response: { content: TEXT, citations: [{ url: "https://example.com", startIndex: -1 }] },
    code: "aimock_invalid_fixture_citation",
    says: ["got startIndex -1, endIndex 12"],
  },
  {
    id: "a file citation without fileId",
    response: { content: TEXT, citations: [{ type: "file", filename: "plan.pdf" }] },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0].fileId must be a non-empty string", "got undefined"],
  },
  {
    id: "a file citation without filename",
    response: { content: TEXT, citations: [{ type: "file", fileId: "file-abc123" }] },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0].filename must be a non-empty string", "got undefined"],
  },
  {
    id: "a file citation with a non-integer index",
    response: {
      content: TEXT,
      citations: [{ type: "file", fileId: "file-abc123", filename: "plan.pdf", index: 1.5 }],
    },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0].index must be an integer"],
  },
  {
    id: "a file citation with an out-of-range index",
    response: {
      content: TEXT,
      citations: [{ type: "file", fileId: "file-abc123", filename: "plan.pdf", index: 99 }],
    },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0].index must satisfy 0 <= index <= text length (12)", "got 99"],
  },
  {
    id: "a citation with an unknown type",
    response: { content: TEXT, citations: [{ type: "web", url: "https://example.com" }] },
    code: "aimock_invalid_fixture_citation",
    says: ['citations[0].type must be "url" or "file"', 'got "web"'],
  },
];

let mock: LLMock | null = null;
afterEach(async () => {
  await mock?.stop();
  mock = null;
});

async function start(response: Record<string, unknown>): Promise<LLMock> {
  mock = new LLMock({ port: 0, logLevel: "silent" });
  // Registration must not throw, whatever the fixture holds.
  mock.addFixture({ match: {}, response: response as unknown as FixtureResponse } as Fixture);
  await mock.start();
  return mock;
}

async function hit(m: LLMock, path: string, body: Record<string, unknown>) {
  const res = await fetch(m.url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, text: await res.text() };
}

/** The aimock code and message from the wire's error envelope. */
function codeAndMessage(shape: Shape, text: string): { code: unknown; message: unknown } {
  const body = JSON.parse(text);
  if (shape === "google") {
    return { code: body.error.details?.[0]?.metadata?.code, message: body.error.message };
  }
  return { code: body.error.code, message: body.error.message };
}

describe.each(badCases)("invalid fixture $id", ({ response, code, says }) => {
  it.each(routes)("$name → coded 500 naming the problem and the fix", async (route) => {
    const m = await start(response);
    const r = await hit(m, route.path, route.body);
    expect(r.status, r.text).toBe(500);
    expect(r.text).not.toContain(TEXT);
    const got = codeAndMessage(route.shape, r.text);
    expect(got.code, r.text).toBe(code);
    for (const fragment of says) expect(String(got.message)).toContain(fragment);
    // The journal keeps the 500 with the matched fixture.
    const entry = m.getRequests().at(-1);
    expect(entry?.response.status).toBe(500);
    expect(entry?.response.fixture).toBe(m.getFixtures()[0]);
  });
});

describe("valid citation offsets at the bounds are served", () => {
  const cases = [
    { startIndex: 0, endIndex: TEXT.length },
    { startIndex: TEXT.length, endIndex: TEXT.length },
    { startIndex: 3, endIndex: 3 },
  ];
  describe.each(cases)("startIndex $startIndex, endIndex $endIndex", (offsets) => {
    it.each(routes)("$name → 200", async (route) => {
      const m = await start({
        content: TEXT,
        citations: [{ url: "https://example.com", ...offsets }],
      });
      const r = await hit(m, route.path, route.body);
      expect(r.status, r.text).toBe(200);
      expect(r.text).toContain("https://example.com");
    });
  });
});

describe("a file citation needs no url", () => {
  const fileCitation = { type: "file", fileId: "file-abc123", filename: "plan.pdf" };
  it.each(routes)("$name → 200", async (route) => {
    const m = await start({ content: TEXT, citations: [fileCitation] });
    const r = await hit(m, route.path, route.body);
    expect(r.status, r.text).toBe(200);
    expect(r.text).not.toContain("aimock_invalid_fixture_citation");
    // Only the Responses API has a file-citation wire shape.
    if (route.path === "/v1/responses") expect(r.text).toContain('"file_id":"file-abc123"');
    else expect(r.text).not.toContain("file-abc123");
  });

  it("validateFixtures gives no citation warning", () => {
    const results = validateFixtures([
      {
        match: {},
        response: {
          content: TEXT,
          citations: [{ type: "file", fileId: "file-abc123", filename: "plan.pdf", index: 0 }],
        },
      },
    ]);
    expect(results.filter((r) => r.message.includes("aimock_invalid_fixture"))).toEqual([]);
  });
});

describe("validateFixtures warns about invalid citations and files", () => {
  it.each(badCases)(
    "$id → warning carrying the serve-time message and code",
    ({ response, code, says }) => {
      const results = validateFixtures([
        { match: {}, response: response as unknown as FixtureResponse } as Fixture,
      ]);
      const warning = results.find((r) => r.message.includes(code));
      expect(warning, JSON.stringify(results)).toBeDefined();
      expect(warning?.severity).toBe("warning");
      for (const fragment of says) expect(warning?.message).toContain(fragment);
    },
  );

  it("valid citations and files produce no such warning", () => {
    const results = validateFixtures([
      {
        match: {},
        response: {
          content: TEXT,
          files: [png],
          citations: [{ url: "https://example.com", startIndex: 0, endIndex: TEXT.length }],
        },
      },
    ]);
    expect(results.filter((r) => r.message.includes("aimock_invalid_fixture"))).toEqual([]);
  });
});

/** A citation case the coded-500 check runs on every route. */
interface HardeningCase {
  id: string;
  response: Record<string, unknown>;
  code: "aimock_invalid_fixture_file" | "aimock_invalid_fixture_citation";
  says: string[];
  /** Fragments the message must not carry (a fix that does not apply). */
  never?: string[];
}

// Values JSON cannot carry: a programmatic fixture can still hold them.
const unserializableCases: HardeningCase[] = [
  {
    id: "a BigInt url",
    response: { content: TEXT, citations: [{ url: 10n }] },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0].url must be a non-empty string", "got 10n"],
  },
  {
    id: "a Symbol url",
    response: { content: TEXT, citations: [{ url: Symbol("src") }] },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0].url must be a non-empty string", "got Symbol(src)"],
  },
  {
    id: "a function url",
    response: { content: TEXT, citations: [{ url: () => "https://example.com" }] },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0].url must be a non-empty string", "got a function"],
  },
  {
    id: "a BigInt file data",
    response: { content: TEXT, files: [{ mimeType: "image/png", data: 1n }] },
    code: "aimock_invalid_fixture_file",
    says: ["files[0].data must be a string", "got 1n"],
  },
  {
    id: "a NaN startIndex",
    response: { content: TEXT, citations: [{ url: "https://example.com", startIndex: NaN }] },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0].startIndex must be an integer", "got NaN"],
  },
  {
    id: "an Infinity endIndex",
    response: {
      content: TEXT,
      citations: [{ url: "https://example.com", endIndex: Infinity }],
    },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0].endIndex must be an integer", "got Infinity"],
  },
];

// "😀" is one code point, two UTF-16 units: index 1 falls between them.
const EMOJI_TEXT = "😀 hi";
const surrogateCases: HardeningCase[] = [
  {
    id: "a startIndex inside a surrogate pair",
    response: {
      content: EMOJI_TEXT,
      citations: [{ url: "https://example.com", startIndex: 1, endIndex: 4 }],
    },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0].startIndex 1 splits a UTF-16 surrogate pair", "fix the offset"],
  },
  {
    id: "an endIndex inside a surrogate pair",
    response: {
      content: EMOJI_TEXT,
      citations: [{ url: "https://example.com", startIndex: 0, endIndex: 1 }],
    },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0].endIndex 1 splits a UTF-16 surrogate pair"],
  },
  {
    id: "a file citation index inside a surrogate pair",
    response: {
      content: EMOJI_TEXT,
      citations: [{ type: "file", fileId: "file-abc123", filename: "plan.pdf", index: 1 }],
    },
    code: "aimock_invalid_fixture_citation",
    says: ["citations[0].index 1 splits a UTF-16 surrogate pair"],
  },
];

const mixedCases: HardeningCase[] = [
  {
    id: "a URL citation with file fields",
    response: {
      content: TEXT,
      citations: [{ url: "https://example.com", fileId: "file-abc123", filename: "plan.pdf" }],
    },
    code: "aimock_invalid_fixture_citation",
    says: [
      "citations[0] mixes URL citation fields (url) with file citation fields (fileId, filename)",
      'set type: "file"',
      "remove the stray fields",
    ],
  },
  {
    id: "a file citation with URL fields",
    response: {
      content: TEXT,
      citations: [
        { type: "file", fileId: "file-abc123", filename: "plan.pdf", url: "https://example.com" },
      ],
    },
    code: "aimock_invalid_fixture_citation",
    says: [
      "citations[0] mixes URL citation fields (url) with file citation fields",
      "remove the URL citation fields (url) from this file citation",
    ],
    never: ['set type: "file"'],
  },
  {
    id: 'a type "url" citation with file fields',
    response: {
      content: TEXT,
      citations: [
        { type: "url", url: "https://example.com", fileId: "file-abc123", filename: "plan.pdf" },
      ],
    },
    code: "aimock_invalid_fixture_citation",
    says: [
      "citations[0] mixes URL citation fields (url) with file citation fields (fileId, filename)",
      "remove the file citation fields (fileId, filename) from this URL citation",
    ],
  },
  {
    id: "a file-shaped citation with no type",
    response: { content: TEXT, citations: [{ fileId: "file-abc123", filename: "plan.pdf" }] },
    code: "aimock_invalid_fixture_citation",
    says: [
      "citations[0] has file citation fields (fileId, filename) but no type",
      'set type: "file"',
      "remove the stray fields",
    ],
  },
  {
    id: 'a type "url" citation with only file fields',
    response: {
      content: TEXT,
      citations: [{ type: "url", fileId: "file-abc123", filename: "plan.pdf" }],
    },
    code: "aimock_invalid_fixture_citation",
    says: [
      'citations[0] has type "url" but file citation fields (fileId, filename)',
      "remove the file citation fields (fileId, filename) from this URL citation",
      'or set type: "file"',
    ],
  },
];

describe.each([...unserializableCases, ...surrogateCases, ...mixedCases])(
  "hardened check: $id",
  ({ response, code, says, never = [] }) => {
    it.each(routes)("$name → coded 500 naming the problem and the fix", async (route) => {
      const m = await start(response);
      const r = await hit(m, route.path, route.body);
      expect(r.status, r.text).toBe(500);
      const got = codeAndMessage(route.shape, r.text);
      expect(got.code, r.text).toBe(code);
      for (const fragment of says) expect(String(got.message)).toContain(fragment);
      for (const fragment of never) expect(String(got.message)).not.toContain(fragment);
    });

    it("validateFixtures warns with the same message", () => {
      const results = validateFixtures([
        { match: {}, response: response as unknown as FixtureResponse } as Fixture,
      ]);
      const warning = results.find((r) => r.message.includes(code));
      expect(warning, String(results.map((r) => r.message))).toBeDefined();
      for (const fragment of says) expect(warning?.message).toContain(fragment);
      for (const fragment of never) expect(warning?.message).not.toContain(fragment);
    });
  },
);

describe("surrogate-pair boundaries are valid offsets", () => {
  it.each(routes)("$name → 200 for offsets around the pair", async (route) => {
    const m = await start({
      content: EMOJI_TEXT,
      citations: [
        { url: "https://example.com", startIndex: 0, endIndex: 2 },
        { url: "https://example.org", startIndex: 2, endIndex: EMOJI_TEXT.length },
      ],
    });
    const r = await hit(m, route.path, route.body);
    expect(r.status, r.text).toBe(200);
    // Both citations reach the wire, each covering its side of the pair.
    expect(citedSpans(route, r.text)).toEqual([
      ["https://example.com", "😀"],
      ["https://example.org", " hi"],
    ]);
  });
});

/** The JSON payloads of a response body: the body itself, or each SSE data line. */
function payloads<T>(text: string): T[] {
  if (text.trimStart().startsWith("{")) return [JSON.parse(text) as T];
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as T);
}

interface ClaudeCite {
  url: string;
  cited_text: string;
}
interface ClaudePayload {
  type: string;
  content?: { citations?: ClaudeCite[] }[];
  delta?: { type?: string; citation?: ClaudeCite };
}
interface GeminiPayload {
  candidates?: {
    groundingMetadata?: {
      groundingChunks: { web: { uri: string } }[];
      groundingSupports: { segment: { text: string }; groundingChunkIndices: number[] }[];
    };
  }[];
}
interface ChatMessage {
  content?: string | null;
  annotations?: { url_citation: { url: string; start_index: number; end_index: number } }[];
}
interface ChatPayload {
  choices: { message?: ChatMessage; delta?: ChatMessage }[];
}
interface ResponsesBody {
  output: {
    content: {
      text: string;
      annotations: { url: string; start_index: number; end_index: number }[];
    }[];
  }[];
}
interface ResponsesPayload extends Partial<ResponsesBody> {
  object?: string;
  type?: string;
  response?: ResponsesBody;
}

/** Each served URL citation as [url, the text it covers], read off the wire. */
function citedSpans(route: Route, text: string): [string, string][] {
  if (route.shape === "messages") {
    return payloads<ClaudePayload>(text)
      .flatMap((p): ClaudeCite[] => {
        if (p.type === "message") return (p.content ?? []).flatMap((b) => b.citations ?? []);
        if (p.delta?.type === "citations_delta" && p.delta.citation) return [p.delta.citation];
        return [];
      })
      .map((c) => [c.url, c.cited_text]);
  }
  if (route.shape === "google") {
    const meta = payloads<GeminiPayload>(text)
      .map((p) => p.candidates?.[0]?.groundingMetadata)
      .find((m) => m !== undefined);
    if (!meta) throw new Error(`no groundingMetadata in ${text}`);
    return meta.groundingSupports.map((s) => [
      meta.groundingChunks[s.groundingChunkIndices[0]].web.uri,
      s.segment.text,
    ]);
  }
  if (route.name.startsWith("Chat")) {
    const messages = payloads<ChatPayload>(text).map(
      (p) => p.choices[0].message ?? p.choices[0].delta ?? {},
    );
    const content = messages.map((m) => m.content ?? "").join("");
    return messages
      .flatMap((m) => m.annotations ?? [])
      .map(({ url_citation: c }) => [c.url, content.slice(c.start_index, c.end_index)]);
  }
  const all = payloads<ResponsesPayload>(text);
  const body =
    all.find((p) => p.object === "response")?.output !== undefined
      ? (all.find((p) => p.object === "response") as ResponsesBody)
      : all.find((p) => p.type === "response.completed")?.response;
  if (!body) throw new Error(`no response body in ${text}`);
  const part = body.output[0].content[0];
  return part.annotations.map((a) => [a.url, part.text.slice(a.start_index, a.end_index)]);
}

/** Mask ids and timestamps, which differ per request. */
function maskVolatile(body: string): string {
  return body
    .replace(/"(\w*[iI]d)":"[^"]*"/g, '"$1":"<id>"')
    .replace(/"(created\w*|completed_at)":\d+/g, '"$1":0');
}

describe("null citations and files are served exactly like absent ones", () => {
  it.each(routes)("$name → byte-identical to the no-field baseline", async (route) => {
    const baseline = await start({ content: TEXT });
    const want = await hit(baseline, route.path, route.body);
    await baseline.stop();
    mock = null;
    const m = await start({ content: TEXT, citations: null, files: null });
    const got = await hit(m, route.path, route.body);
    expect(got.status, got.text).toBe(200);
    expect(want.status).toBe(200);
    expect(maskVolatile(got.text)).toBe(maskVolatile(want.text));
  });

  it("validateFixtures gives no citation or file warning", () => {
    const results = validateFixtures([
      {
        match: {},
        response: { content: TEXT, citations: null, files: null },
      } as unknown as Fixture,
    ]);
    expect(results.filter((r) => r.message.includes("aimock_invalid_fixture"))).toEqual([]);
  });
});

/**
 * The load-time check validates citation offsets against the same text the
 * serve-time check uses: the joined text of every text block when `blocks` is
 * set, else `content`. A turn with no text (tool calls only, or blocks with no
 * text block) has nothing to cite: a well-formed non-empty `citations` there
 * is the same no-text warning the wires answer as a 500. A malformed value is
 * reported by its shape first, with or without text.
 */
describe("validateFixtures checks citation offsets against the served text", () => {
  const url = "https://example.com";
  const toolBlock = { type: "toolCall", name: "lookup", arguments: "{}" };

  function citationWarnings(response: Record<string, unknown>) {
    return validateFixtures([
      { match: {}, response: response as unknown as FixtureResponse } as Fixture,
    ]).filter((r) => r.message.includes("aimock_invalid_fixture_citation"));
  }

  it("blocks only, offsets past the joined text → warning", () => {
    const warnings = citationWarnings({
      blocks: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world." },
      ],
      citations: [{ url, endIndex: 99 }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe("warning");
    expect(warnings[0].message).toContain("text length (12)");
    expect(warnings[0].message).toContain("got startIndex 0, endIndex 99");
  });

  it("blocks only, offsets inside the joined text across a tool block → no warning", () => {
    expect(
      citationWarnings({
        blocks: [{ type: "text", text: "Hello " }, toolBlock, { type: "text", text: "world." }],
        citations: [{ url, startIndex: 3, endIndex: 12 }],
      }),
    ).toEqual([]);
  });

  it("content and blocks, offsets valid for the blocks text only → no warning", () => {
    expect(
      citationWarnings({
        content: "Hi",
        blocks: [{ type: "text", text: TEXT }],
        citations: [{ url, startIndex: 3, endIndex: 12 }],
      }),
    ).toEqual([]);
  });

  it("content and blocks, offsets valid for the content only → warning", () => {
    const warnings = citationWarnings({
      content: "Hello world, and more.",
      blocks: [{ type: "text", text: "Hi" }],
      citations: [{ url, startIndex: 3, endIndex: 12 }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("text length (2)");
  });

  it("tool-call blocks only, offsets past the empty text → no-text warning", () => {
    const warnings = citationWarnings({
      blocks: [toolBlock],
      citations: [{ url, startIndex: 0, endIndex: 5 }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("this turn has no text");
  });

  it("tool-call blocks only, no offsets → no-text warning", () => {
    const warnings = citationWarnings({ blocks: [toolBlock], citations: [{ url }] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("this turn has no text");
  });

  it("toolCalls only (no text) → no-text warning for a well-formed value", () => {
    const toolCalls = [{ name: "lookup", arguments: "{}" }];
    const warnings = citationWarnings({ toolCalls, citations: [{ url, endIndex: 5 }] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("this turn has no text");
  });

  it("toolCalls only (no text) → shape warning for a malformed value", () => {
    const toolCalls = [{ name: "lookup", arguments: "{}" }];
    const warnings = citationWarnings({ toolCalls, citations: { url } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('"citations" must be an array');
    expect(warnings[0].message).not.toContain("this turn has no text");
  });
});

describe("the served text is the one validateFixtures checks", () => {
  it.each(routes)(
    "$name: content and blocks, offsets valid for the blocks text → 200",
    async (route) => {
      const m = await start({
        content: "Hi",
        blocks: [{ type: "text", text: TEXT }],
        citations: [{ url: "https://example.com", startIndex: 3, endIndex: 12 }],
      });
      const r = await hit(m, route.path, route.body);
      expect(r.status, r.text).toBe(200);
      expect(r.text).toContain("https://example.com");
    },
  );

  it.each(routes)("$name: blocks only, offsets past the joined text → 500", async (route) => {
    const m = await start({
      blocks: [{ type: "text", text: TEXT }],
      citations: [{ url: "https://example.com", endIndex: 99 }],
    });
    const r = await hit(m, route.path, route.body);
    expect(r.status, r.text).toBe(500);
    expect(codeAndMessage(route.shape, r.text).code).toBe("aimock_invalid_fixture_citation");
  });

  it.each(routes)("$name: toolCalls only with a malformed citations value → 500", async (route) => {
    const m = await start({
      toolCalls: [{ name: "lookup", arguments: "{}" }],
      citations: { url: "https://example.com" },
    });
    const r = await hit(m, route.path, route.body);
    expect(r.status, r.text).toBe(500);
    const got = codeAndMessage(route.shape, r.text);
    expect(got.code).toBe("aimock_invalid_fixture_citation");
    expect(String(got.message)).toContain('"citations" must be an array');
  });
});

/**
 * Citations on a turn with no text (tool calls only, `blocks` with no text
 * block, or empty `content`) have nothing to point at, so they are a fixture
 * error on every wire: a coded 500
 * (`aimock_invalid_fixture_citation`) that says to add text or remove the
 * citations, and the same message as a load-time warning. A malformed value
 * there names its shape problem instead, the same as on a turn with text. A turn with no
 * `citations` key, or an empty array, is served exactly as before.
 */
describe("citations on a turn with no text", () => {
  const toolCalls = [{ id: "call_abc123", name: "get_weather", arguments: '{"city":"SF"}' }];
  const says = ["this turn has no text", "add text to the response or remove the citations"];
  const noTextCases: { id: string; response: Record<string, unknown>; says?: string[] }[] = [
    {
      id: "tool calls with a valid-looking citation",
      response: { toolCalls, citations: [{ url: "https://example.com", title: "Example" }] },
    },
    {
      id: "tool calls with a malformed citation",
      response: { toolCalls, citations: [{ title: "Example" }] },
      says: ["citations[0].url must be a non-empty string"],
    },
    {
      id: "tool calls with a non-array citations value",
      response: { toolCalls, citations: { url: "https://example.com" } },
      says: ['"citations" must be an array'],
    },
    {
      id: "empty content with a citation",
      response: { content: "", citations: [{ url: "https://example.com" }] },
    },
    {
      id: "blocks with only a tool call, with a citation",
      response: {
        blocks: [{ type: "toolCall", ...toolCalls[0] }],
        citations: [{ url: "https://example.com" }],
      },
    },
    {
      id: "blocks with an empty text block and a tool call, with a citation",
      response: {
        blocks: [
          { type: "text", text: "" },
          { type: "toolCall", ...toolCalls[0] },
        ],
        citations: [{ url: "https://example.com" }],
      },
    },
  ];

  describe.each(noTextCases)("$id", ({ response, says: expected = says }) => {
    it.each(routes)("$name → coded 500 that names the problem", async (route) => {
      const m = await start(response);
      const r = await hit(m, route.path, route.body);
      expect(r.status, r.text).toBe(500);
      const got = codeAndMessage(route.shape, r.text);
      expect(got.code, r.text).toBe("aimock_invalid_fixture_citation");
      for (const fragment of expected) expect(String(got.message)).toContain(fragment);
      expect(r.text).not.toContain("get_weather");
      const entry = m.getRequests().at(-1);
      expect(entry?.response.status).toBe(500);
      expect(entry?.response.fixture).toBe(m.getFixtures()[0]);
    });

    it("validateFixtures warns with the serve-time message", async () => {
      const m = await start(response);
      const r = await hit(m, routes[0].path, routes[0].body);
      const served = String(codeAndMessage("openai", r.text).message).replace(
        'aimock: invalid fixture "citations": ',
        "",
      );
      const results = validateFixtures([
        { match: {}, response: response as unknown as FixtureResponse } as Fixture,
      ]);
      const warning = results.find((w) => w.message.includes("aimock_invalid_fixture_citation"));
      expect(warning, JSON.stringify(results)).toBeDefined();
      expect(warning?.severity).toBe("warning");
      expect(warning?.message).toBe(
        `${served} — requests it serves on Chat Completions, Anthropic Messages, Gemini or ` +
          `the OpenAI Responses API answer a 500 (aimock_invalid_fixture_citation)`,
      );
    });
  });

  // Random per-response IDs and timestamps differ between two requests.
  const normalize = (text: string) =>
    text.replace(/"(id|item_id|call_id|created|created_at|responseId)":("[^"]*"|\d+)/g, '"$1":_');

  it.each(routes)(
    "$name → an empty citations array on a tool-only turn is unchanged",
    async (route) => {
      const without = await hit(await start({ toolCalls }), route.path, route.body);
      await mock?.stop();
      mock = null;
      const withEmpty = await hit(
        await start({ toolCalls, citations: [] }),
        route.path,
        route.body,
      );
      expect(without.status, without.text).toBe(200);
      expect(withEmpty.status, withEmpty.text).toBe(200);
      expect(withEmpty.text).toContain("get_weather");
      expect(normalize(withEmpty.text)).toBe(normalize(without.text));
    },
  );

  it("validateFixtures gives no citation warning for an empty array on a tool-only turn", () => {
    const results = validateFixtures([{ match: {}, response: { toolCalls, citations: [] } }]);
    expect(results.filter((r) => r.message.includes("aimock_invalid_fixture"))).toEqual([]);
  });
});
