/**
 * A fixture's `citations` and `files` are checked for shape and wire support
 * before any misbehavior fault rewrites the turn, the same on every wire and
 * fault. A malformed value answers its coded 500 with or without a fault; a
 * valid value under a fault that alters the reply text is served without the
 * citations (they index text that is no longer sent).
 *
 * Real surface: a real aimock server over HTTP, reading its own journal.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ServerInstance } from "../server.js";
import type {
  Fixture,
  FixtureResponse,
  MisbehaviorFault,
  HandlerDefaults,
  MockServerOptions,
} from "../types.js";
import { fixtureCitationsProblem } from "../helpers.js";
import {
  planMisbehavior,
  setFixtureMisbehaviorPosition,
  supportsMisbehavior,
} from "../misbehavior.js";
import { Journal } from "../journal.js";
import { Logger } from "../logger.js";
import { createServer } from "./helpers/misbehavior-enabled.js";

const CITED_URL = "https://example.com/cited";
const text = "Sunny today.";
const toolCalls = [{ id: "call_1", name: "lookup", arguments: '{"q":"paris"}' }];

type WireName = "openai-chat" | "anthropic" | "gemini" | "openai-responses";

interface Route {
  path: string;
  body: Record<string, unknown>;
}

function route(wire: WireName, stream: boolean): Route {
  switch (wire) {
    case "openai-chat":
      return {
        path: "/v1/chat/completions",
        body: { model: "gpt-4o", stream, messages: [{ role: "user", content: "go" }] },
      };
    case "anthropic":
      return {
        path: "/v1/messages",
        body: {
          model: "claude-sonnet-4-5",
          max_tokens: 64,
          stream,
          messages: [{ role: "user", content: "go" }],
        },
      };
    case "gemini":
      return {
        path: `/v1beta/models/gemini-2.0-flash:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
        body: {
          contents: [{ role: "user", parts: [{ text: "go" }] }],
          tools: [{ functionDeclarations: [{ name: "lookup", parameters: { type: "object" } }] }],
        },
      };
    case "openai-responses":
      return { path: "/v1/responses", body: { model: "gpt-4o", input: "go", stream } };
  }
}

const WIRES: WireName[] = ["openai-chat", "anthropic", "gemini", "openai-responses"];
const FAULTS: MisbehaviorFault[] = [
  { fault: "refusal" },
  { fault: "empty-response" },
  { fault: "content-filter" },
  { fault: "reasoning-only", reasoning: "Hm." },
  { fault: "stop-length-mid-tool" },
];
/** Faults that replace or empty the reply text (stop-length keeps `content` here). */
const TEXT_REMOVING = new Set(["refusal", "empty-response", "content-filter", "reasoning-only"]);

let instance: ServerInstance | undefined;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
    instance = undefined;
  }
});

async function serve(
  wire: WireName,
  stream: boolean,
  response: FixtureResponse,
  fault: MisbehaviorFault | undefined,
  options: MockServerOptions = {},
): Promise<{ status: number; body: string; fixture: Fixture }> {
  const fixture: Fixture = {
    match: {},
    response,
    ...(fault ? { misbehavior: { faults: [{ ...fault, rate: 1 }] } } : {}),
  };
  instance = await createServer([fixture], options);
  const { path, body } = route(wire, stream);
  const res = await fetch(`${instance.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text(), fixture };
}

/** Malformed fixtures: programmatic fixtures skip load validation. */
const malformed: { name: string; response: FixtureResponse; code: string }[] = [
  {
    name: "malformed citations",
    response: {
      content: text,
      toolCalls,
      citations: [{ title: "no url" }],
    } as unknown as FixtureResponse,
    code: "aimock_invalid_fixture_citation",
  },
  {
    name: "malformed files",
    response: {
      content: text,
      toolCalls,
      files: [{ mimeType: "image/png" }],
    } as unknown as FixtureResponse,
    code: "aimock_invalid_fixture_file",
  },
];

const malformedCells = malformed.flatMap((m) =>
  FAULTS.flatMap((fault) =>
    WIRES.flatMap((wire) =>
      [false, true].map((stream) => ({ ...m, fault, wire, stream, faultName: fault.fault })),
    ),
  ),
);

describe("a malformed fixture output is its coded 500 under every fault on every wire", () => {
  it.each(malformedCells)(
    "$name × $faultName × $wire stream=$stream",
    async ({ response, code, fault, wire, stream }) => {
      const { status, body, fixture } = await serve(wire, stream, response, fault);
      expect(status, body).toBe(500);
      expect(body).toContain(code);
      const entries = instance!.journal.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].response.status).toBe(500);
      expect(entries[0].response.fixture).toBe(fixture);
      expect(
        (entries[0].response.misbehavior?.evaluations ?? []).filter(
          (row) => row.outcome === "applied",
        ),
      ).toEqual([]);
    },
  );

  // The same fixture with no fault: the baseline every fault cell must match.
  it.each(
    malformed.flatMap((m) =>
      WIRES.flatMap((wire) => [false, true].map((stream) => ({ ...m, wire, stream }))),
    ),
  )("$name × no fault × $wire stream=$stream", async ({ response, code, wire, stream }) => {
    const { status, body } = await serve(wire, stream, response, undefined);
    expect(status, body).toBe(500);
    expect(body).toContain(code);
  });
});

const validCited: FixtureResponse = {
  content: text,
  toolCalls,
  citations: [{ url: CITED_URL, title: "Forecast", startIndex: 0, endIndex: 5 }],
};

const validCells = FAULTS.flatMap((fault) =>
  WIRES.flatMap((wire) =>
    [false, true]
      .filter((stream) => supportsMisbehavior(wire, fault, stream))
      .map((stream) => ({ fault, wire, stream, faultName: fault.fault })),
  ),
);

describe("valid citations under a text-altering fault are served without the citations", () => {
  it.each(validCells)("$faultName × $wire stream=$stream", async ({ fault, wire, stream }) => {
    const { status, body } = await serve(wire, stream, validCited, fault);
    expect(status, body).toBe(200);
    expect(body).not.toContain("aimock_invalid_fixture");
    if (TEXT_REMOVING.has(fault.fault)) expect(body).not.toContain(CITED_URL);
    const entries = instance!.journal.getAll();
    expect((entries[0].response.misbehavior?.evaluations ?? []).map((r) => r.outcome)).toEqual([
      "applied",
    ]);
  });
});

describe("citations on a tool-only turn are a 500 under stop-length-mid-tool on every wire", () => {
  const toolOnly = {
    toolCalls,
    citations: [{ url: CITED_URL }],
  } as FixtureResponse;
  it.each(WIRES.flatMap((wire) => [false, true].map((stream) => ({ wire, stream }))))(
    "$wire stream=$stream",
    async ({ wire, stream }) => {
      const { status, body } = await serve(wire, stream, toolOnly, {
        fault: "stop-length-mid-tool",
      });
      expect(status, body).toBe(500);
      expect(body).toContain("aimock_invalid_fixture_citation");
    },
  );
});

describe("a non-image file under a withholding fault on Responses is its coded 500", () => {
  it.each(
    FAULTS.filter((f) => TEXT_REMOVING.has(f.fault)).flatMap((fault) =>
      [false, true].map((stream) => ({ fault, stream, faultName: fault.fault })),
    ),
  )("$faultName stream=$stream", async ({ fault, stream }) => {
    const { status, body } = await serve(
      "openai-responses",
      stream,
      { content: text, files: [{ mimeType: "application/pdf", data: "JVBERi0=" }] },
      fault,
    );
    expect(status, body).toBe(500);
    expect(body).toContain("aimock_unsupported_generated_file");
  });
});

/**
 * A malformed `responsesBlocks` is a fixture error on every wire. The planner
 * must not throw its own plain Error for it before the request is journaled:
 * it leaves the fixture to the normal path, which answers exactly as it does
 * with no fault configured.
 */
describe("a malformed responsesBlocks under a fault on a non-Responses wire", () => {
  const response = {
    content: text,
    toolCalls,
    responsesBlocks: [{ type: "text", text: 5 }],
  } as unknown as FixtureResponse;
  const nonResponses = ["openai-chat", "anthropic", "gemini"] as const;

  it.each(nonResponses)("the planner leaves it to the normal path on %s", (wire) => {
    const fixture: Fixture = { match: {}, response };
    setFixtureMisbehaviorPosition(fixture, "code#0");
    const journal = new Journal();
    const defaults: HandlerDefaults = {
      latency: 0,
      chunkSize: 10,
      replaySpeed: 1,
      logger: new Logger(),
      misbehavior: {
        baseline: { faults: [{ fault: "stop-length-mid-tool" }] },
        byTestId: new Map(),
      },
      misbehaviorCounters: journal,
    };
    expect(
      planMisbehavior({
        wire,
        fixture,
        response,
        request: { model: "gpt", messages: [] },
        stream: false,
        defaults,
        rawHeaders: { "x-test-id": "case" },
        url: undefined,
      }),
    ).toEqual({ kind: "skipped" });
  });

  it.each(nonResponses.flatMap((wire) => [false, true].map((stream) => ({ wire, stream }))))(
    "$wire stream=$stream answers as with no fault, journaled",
    async ({ wire, stream }) => {
      const extended: MockServerOptions = { responsesTools: "extended" };
      const baseline = await serve(wire, stream, response, undefined, extended);
      await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
      instance = undefined;
      const faulted = await serve(
        wire,
        stream,
        response,
        { fault: "stop-length-mid-tool" },
        extended,
      );
      expect(faulted.status, faulted.body).toBe(500);
      expect(faulted.status).toBe(baseline.status);
      expect(faulted.body).toContain("Invalid fixture block at index 0");
      expect(JSON.parse(faulted.body).error.message).toBe(JSON.parse(baseline.body).error.message);
      const entries = instance!.journal.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].response.status).toBe(500);
    },
  );
});

describe("null optional citation fields are absent", () => {
  it("fixtureCitationsProblem accepts null optional fields", () => {
    expect(
      fixtureCitationsProblem(
        [
          { url: CITED_URL, title: null, startIndex: null, endIndex: null, type: null },
          { type: "file", fileId: "file-1", filename: "a.pdf", index: null },
        ],
        text,
      ),
    ).toBeUndefined();
  });

  it.each(WIRES.flatMap((wire) => [false, true].map((stream) => ({ wire, stream }))))(
    "$wire stream=$stream serves the citation",
    async ({ wire, stream }) => {
      const { status, body } = await serve(
        wire,
        stream,
        {
          content: text,
          citations: [{ url: CITED_URL, title: null, startIndex: null, endIndex: null }],
        } as unknown as FixtureResponse,
        undefined,
      );
      expect(status, body).toBe(200);
      expect(body).toContain(CITED_URL);
    },
  );
});

describe("a non-array citations on a turn with no text reports its shape", () => {
  it("fixtureCitationsProblem names the shape, not the missing text", () => {
    expect(fixtureCitationsProblem("oops", "")).toContain("must be an array");
  });

  it.each(WIRES.flatMap((wire) => [false, true].map((stream) => ({ wire, stream }))))(
    "$wire stream=$stream",
    async ({ wire, stream }) => {
      const { status, body } = await serve(
        wire,
        stream,
        { toolCalls, citations: "oops" } as unknown as FixtureResponse,
        undefined,
      );
      expect(status, body).toBe(500);
      expect(body).toContain("must be an array");
    },
  );
});
