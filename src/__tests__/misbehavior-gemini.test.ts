import { GoogleGenAI, type GenerateContentResponse, type FunctionDeclaration } from "@google/genai";
import { expect, test } from "vitest";
import { withFaultFixture } from "./helpers/misbehavior-server.js";
import type { FixtureFileResponse, MisbehaviorFault, ToolCall } from "../types.js";
import { LLMock } from "./helpers/misbehavior-enabled.js";

const routes = [false, true].flatMap((vertex) =>
  [false, true].map((stream) => ({
    vertex,
    stream,
    id: `${vertex ? "vertex" : "gemini"}-${stream ? "stream" : "nonstream"}`,
  })),
);
const tool = { name: "lookup", arguments: { city: "Paris" }, id: "call_lookup" };
const schema = {
  type: "object",
  properties: { city: { type: "string", enum: ["Paris", "London"] } },
  required: ["city"],
  additionalProperties: false,
};
const tools: FunctionDeclaration[] = [{ name: "lookup", parametersJsonSchema: schema }];
const shapes: { shape: string; response: FixtureFileResponse }[] = [
  { shape: "tools", response: { toolCalls: [tool] } },
  { shape: "mixed", response: { content: "Before.", toolCalls: [tool] } },
  {
    shape: "blocks",
    response: {
      blocks: [
        { type: "text", text: "Before." },
        { type: "toolCall", ...tool },
        { type: "text", text: "After." },
      ],
    },
  },
];

async function probe(
  route: (typeof routes)[number],
  fault: MisbehaviorFault | undefined,
  response: FixtureFileResponse = shapes[0].response,
  declarations: FunctionDeclaration[] = tools,
) {
  return withFaultFixture(
    fault ? { faults: [fault] } : undefined,
    async ({ mock, url }) => {
      const model = "gemini-2.5-flash";
      const resource = route.vertex
        ? `projects/local/locations/us-central1/publishers/google/models/${model}`
        : `models/${model}`;
      const apiVersion = route.vertex ? "v1" : "v1beta";
      const nativeTools = declarations.length
        ? [{ functionDeclarations: declarations }]
        : undefined;
      const raw = await fetch(
        `${url}/${apiVersion}/${resource}:${route.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "weather" }] }],
            tools: nativeTools,
          }),
          signal: AbortSignal.timeout(5000),
        },
      );
      const wire = { status: raw.status, body: await raw.text() };
      const client = new GoogleGenAI({
        vertexai: route.vertex,
        apiKey: "local",
        httpOptions: { baseUrl: url, apiVersion, timeout: 5000, retryOptions: { attempts: 1 } },
      });
      const chunks: GenerateContentResponse[] = [];
      let sdkError: unknown;
      try {
        const request = {
          model: route.vertex ? resource : model,
          contents: "weather",
          config: { tools: nativeTools },
        };
        if (route.stream) {
          for await (const chunk of await client.models.generateContentStream(request))
            chunks.push(chunk);
        } else chunks.push(await client.models.generateContent(request));
      } catch (error) {
        sdkError = error;
      }
      const entries = mock.getRequests();
      console.log(
        JSON.stringify({
          route: route.id,
          fault,
          wire,
          chunks,
          sdkError:
            sdkError instanceof Error
              ? { name: sdkError.name, message: sdkError.message }
              : sdkError,
          entries,
        }),
      );
      expect(wire.status).toBe(200);
      expect(sdkError).toBeUndefined();
      expect(entries).toHaveLength(2);
      const parts = chunks.flatMap(
        (chunk) => chunk.candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? [],
      );
      const terminal = chunks.at(-1)?.candidates?.[0];
      const usage = chunks.at(-1)?.usageMetadata;
      if (fault) {
        const output = parts
          .map(
            (part) =>
              part.text ??
              (part.functionCall
                ? part.functionCall.name + JSON.stringify(part.functionCall.args)
                : ""),
          )
          .join("");
        expect(usage).toMatchObject({
          promptTokenCount: 2,
          candidatesTokenCount: Math.max(1, Math.ceil(output.length / 4)),
        });
      } else if ("usage" in response && response.usage) {
        expect(usage).toMatchObject(response.usage);
      }

      const calls = parts.flatMap((part) => (part.functionCall ? [part.functionCall] : []));
      const servedCalls = calls.map((call) => ({
        name: call.name,
        arguments: JSON.stringify(call.args),
        ...(call.id ? { id: call.id } : {}),
      }));
      for (const entry of entries) {
        expect(entry.response.status).toBe(200);
        if (fault) {
          expect(entry.response.misbehavior).toMatchObject({
            applied: true,
            fault: fault.fault,
            wire: "gemini",
            servedToolCalls: servedCalls,
          });
          expect(entry.response.misbehavior?.evaluations).toHaveLength(1);
          expect(entry.response.misbehavior?.evaluations[0]).toMatchObject({
            outcome: "applied",
            ordinal: entries.indexOf(entry),
          });
        } else expect(entry.response.misbehavior).toBeUndefined();
      }
      if (fault?.fault === "tool-args-invalid-json") {
        expect(terminal).toMatchObject({
          finishReason: "MALFORMED_FUNCTION_CALL",
        });
        const nativeChunks: GenerateContentResponse[] = route.stream
          ? wire.body
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data: "))
              .map((line) => JSON.parse(line.slice(6)))
          : [JSON.parse(wire.body)];
        const nativeCandidate = nativeChunks.at(-1)?.candidates?.[0];
        expect(nativeCandidate).not.toHaveProperty("content");
        expect(terminal).not.toHaveProperty("content");
        expect(nativeCandidate?.finishMessage).toMatch(/invalid|malformed/i);
        expect(nativeCandidate?.finishMessage).toContain("lookup(");
        expect(nativeCandidate?.finishMessage).toContain(
          fault.style === "single-quotes" ? "'city'" : '"city"',
        );
        // @google/genai 1.50.1 candidateFromMldev omits finishMessage. Vertex preserves it.
        // Keep SDK terminal/no-call proof and assert this native diagnostic on raw transport.
        if (route.vertex) expect(terminal?.finishMessage).toMatch(/invalid|malformed/i);
        else expect(terminal?.finishMessage).toBeUndefined();
        expect(parts).toEqual([]);
        expect(chunks.flatMap((chunk) => chunk.functionCalls ?? [])).toEqual([]);
      } else if (fault?.fault === "tool-args-schema-violation") {
        const args = calls[0]?.args;
        expect(calls).toHaveLength(1);
        if (fault.violation === "missing-required") expect(args).toEqual({});
        if (fault.violation === "wrong-type") expect(typeof args?.city).not.toBe("string");
        if (fault.violation === "extra-property") expect(args).toHaveProperty("__aimock_extra");
        if (fault.violation === "enum-mismatch")
          expect(["Paris", "London"]).not.toContain(args?.city);
        for (const entry of entries)
          expect(entry.body).toMatchObject({ tools: [{ function: { parameters: schema } }] });
      } else if (fault?.fault === "tool-unknown-name") {
        expect(terminal?.finishReason).toBe(declarations.length ? "STOP" : "UNEXPECTED_TOOL_CALL");
        if (declarations.length) expect(calls[0]?.name).toBe(fault.name ?? "lookup_v2");
        else expect(parts).toEqual([]);
      } else if (fault?.fault === "tool-call-id-duplicate") {
        expect(calls).toHaveLength(2);
        expect(calls[0].id).toBe("call_lookup");
        expect(calls[1].id).toBe("call_lookup");
      } else if (fault?.fault === "stop-length-mid-tool") {
        expect(terminal?.finishReason).toBe("MAX_TOKENS");
        expect(calls).toEqual([]);
        expect(parts.map((part) => part.text ?? "").join("")).toBe(
          "content" in response || "blocks" in response ? "Before." : "",
        );
      } else if (fault?.fault === "empty-response") {
        expect(terminal?.finishReason).toBe("STOP");
        expect(parts.every((part) => !part.functionCall && !part.thought && !part.text)).toBe(true);
      } else if (fault?.fault === "content-filter") {
        expect(terminal).toMatchObject({
          finishReason: "SAFETY",
          safetyRatings: [
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "HIGH", blocked: true },
          ],
        });
        expect(parts).toEqual([]);
      } else if (fault?.fault === "reasoning-only") {
        expect(terminal?.finishReason).toBe("MAX_TOKENS");
        expect(parts.every((part) => part.thought === true && !part.functionCall)).toBe(true);
        expect(parts.map((part) => part.text ?? "").join("")).toBe("Thinking only.");
      } else {
        expect(calls).toEqual([{ id: "call_lookup", name: "lookup", args: { city: "Paris" } }]);
      }
    },
    { response },
  );
}
const faults: MisbehaviorFault[] = [
  { fault: "tool-args-invalid-json" },
  ...(["missing-required", "wrong-type", "extra-property", "enum-mismatch"] as const).map(
    (violation) => ({ fault: "tool-args-schema-violation" as const, violation }),
  ),
  { fault: "tool-unknown-name" },
  { fault: "tool-call-id-duplicate" },
  { fault: "stop-length-mid-tool" },
  { fault: "empty-response" },
  { fault: "content-filter" },
  { fault: "reasoning-only", reasoning: "Thinking only." },
];
test.each(
  routes.flatMap((route) =>
    shapes.flatMap((shape) =>
      faults.map((fault) => ({
        ...route,
        ...shape,
        fault,
        label: fault.fault + ("violation" in fault ? `:${fault.violation}` : ""),
      })),
    ),
  ),
)("$id $shape $label official SDK and native wire", async (scenario) => {
  await probe(scenario, scenario.fault, scenario.response);
});
test.each(routes)("$id K3 no declared tools uses native unexpected-call signal", async (route) => {
  await probe(route, { fault: "tool-unknown-name" }, shapes[0].response, []);
});
test.each(routes.flatMap((route) => shapes.map((shape) => ({ ...route, ...shape }))))(
  "$id $shape no fault control",
  async (scenario) => {
    await probe(scenario, undefined, scenario.response);
  },
);

test.each(routes)(
  "$id applied usage ignores fixture overrides; ordinary usage preserves them",
  async (route) => {
    const response = {
      ...shapes[0].response,
      usage: { promptTokenCount: 901, candidatesTokenCount: 902, totalTokenCount: 1803 },
    };
    await probe(route, { fault: "empty-response" }, response);
    await probe(route, undefined, response);
  },
);

test.each(routes)(
  "$id named K4 uses only selected authored identity and no-ID target is inapplicable",
  async (route) => {
    const mock = new LLMock({ port: 0, logLevel: "silent" });
    let factories = 0;
    const calls: ToolCall[] = [
      { name: "first", arguments: "{}", id: "first_id" },
      { name: "second", arguments: "{}", id: "second_id" },
    ];
    mock.addFixture({
      match: {},
      response: () => {
        factories++;
        return { toolCalls: calls };
      },
    });
    await mock.start();
    try {
      const model = "gemini-2.5-flash";
      const resource = route.vertex
        ? `projects/local/locations/us-central1/publishers/google/models/${model}`
        : model;
      const client = new GoogleGenAI({
        vertexai: route.vertex,
        apiKey: "local",
        httpOptions: {
          baseUrl: mock.url,
          apiVersion: route.vertex ? "v1" : "v1beta",
          timeout: 5000,
          retryOptions: { attempts: 1 },
          headers: { "x-aimock-misbehavior": "tool-call-id-duplicate;tool=second" },
        },
      });
      const request = { model: resource, contents: "weather" };
      const chunks: GenerateContentResponse[] = [];
      if (route.stream)
        for await (const chunk of await client.models.generateContentStream(request))
          chunks.push(chunk);
      else chunks.push(await client.models.generateContent(request));
      const served = chunks.flatMap((chunk) => chunk.functionCalls ?? []);
      console.log(
        JSON.stringify({
          route: route.id,
          label: "namedK4",
          chunks,
          journal: mock.getRequests(),
          factories,
        }),
      );
      expect(served.map((call) => ({ name: call.name, id: call.id }))).toEqual([
        { name: "first", id: "second_id" },
        { name: "second", id: "second_id" },
      ]);
      expect(mock.getRequests()).toHaveLength(1);
      expect(factories).toBe(1);
      expect(calls).toEqual([
        { name: "first", arguments: "{}", id: "first_id" },
        { name: "second", arguments: "{}", id: "second_id" },
      ]);
      expect(mock.getRequests()[0].response.misbehavior).toMatchObject({
        target: { tool: "second", index: 1 },
        servedToolCalls: [
          { name: "first", id: "second_id", arguments: "{}" },
          { name: "second", id: "second_id", arguments: "{}" },
        ],
      });
      delete calls[1].id;
      const next = route.stream
        ? client.models.generateContentStream(request)
        : client.models.generateContent(request);
      await expect(next).rejects.toThrow();
      expect(factories).toBe(2);
      expect(mock.getRequests()).toHaveLength(2);
      expect(mock.getRequests()[1].response).toMatchObject({
        status: 501,
        misbehavior: {
          reason: "not-applicable",
          evaluations: [{ reason: "not-applicable", outcome: "error" }],
        },
      });
      expect(mock.getRequests()[1].response.misbehavior?.evaluations[0].ordinal).toBeUndefined();
    } finally {
      await mock.stop();
    }
  },
);

const parameterCases: MisbehaviorFault[] = [
  { fault: "tool-args-invalid-json", style: "trailing-comma" },
  { fault: "tool-args-invalid-json", style: "single-quotes" },
  { fault: "tool-unknown-name", name: "undeclared_lookup" },
  { fault: "stop-length-mid-tool", at: 0.25 },
];
test.each(
  routes.flatMap((route) =>
    parameterCases.map((fault) => ({ ...route, fault, label: JSON.stringify(fault) })),
  ),
)("$id authored parameters $label", async (scenario) => {
  await probe(scenario, scenario.fault);
});

const idCases = [
  { name: "first-authored", target: "first", sourceId: "first_id", scoped: false, blocks: false },
  {
    name: "nonfirst-authored",
    target: "second",
    sourceId: "second_id",
    scoped: false,
    blocks: false,
  },
  { name: "nonfirst-absent", target: "second", sourceId: undefined, scoped: false, blocks: false },
  { name: "nonfirst-empty", target: "second", sourceId: "", scoped: false, blocks: false },
  {
    name: "ordered-nonfirst",
    target: "second",
    sourceId: "second_id",
    scoped: false,
    blocks: true,
  },
  { name: "scoped-multiple", target: "second", sourceId: undefined, scoped: true, blocks: true },
];
test.each(routes.flatMap((route) => idCases.map((scenario) => ({ ...route, ...scenario }))))(
  "$id E7 selected original ID mode $name",
  async (scenario) => {
    const selectedCalls: ToolCall[] = [
      { name: "first", arguments: '{"one":1}', id: "first_id" },
      {
        name: "second",
        arguments: '{"two":2}',
        ...(scenario.sourceId !== undefined ? { id: scenario.sourceId } : {}),
      },
    ];
    const original = structuredClone(selectedCalls);
    const faults: MisbehaviorFault[] = scenario.scoped
      ? [
          { fault: "tool-call-id-duplicate", tool: "second", times: 1 },
          { fault: "tool-call-id-duplicate", tool: "first", times: 1 },
        ]
      : [{ fault: "tool-call-id-duplicate", tool: scenario.target }];
    let factories = 0;
    const mock = new LLMock({
      port: 0,
      logLevel: "silent",
      ...(scenario.scoped ? { misbehavior: { faults } } : {}),
    });
    mock.addFixture({
      match: {},
      response: () => {
        factories++;
        return scenario.blocks
          ? {
              toolCalls: [{ name: "stale", arguments: "{}", id: "stale_id" }],
              blocks: [
                { type: "text", text: "Before." },
                ...selectedCalls.map((call) => ({ type: "toolCall" as const, ...call })),
              ],
            }
          : { toolCalls: selectedCalls };
      },
      ...(scenario.scoped ? {} : { misbehavior: { faults } }),
    });
    await mock.start();
    try {
      const model = "gemini-2.5-flash";
      const client = new GoogleGenAI({
        vertexai: scenario.vertex,
        apiKey: "local",
        httpOptions: {
          baseUrl: mock.url,
          apiVersion: scenario.vertex ? "v1" : "v1beta",
          timeout: 5000,
          retryOptions: { attempts: 1 },
        },
      });
      const request = {
        model: scenario.vertex
          ? `projects/local/locations/us-central1/publishers/google/models/${model}`
          : model,
        contents: "weather",
      };
      async function turn() {
        const chunks: GenerateContentResponse[] = [];
        let error: unknown;
        try {
          if (scenario.stream)
            for await (const chunk of await client.models.generateContentStream(request))
              chunks.push(chunk);
          else chunks.push(await client.models.generateContent(request));
        } catch (caught) {
          error = caught;
        }
        console.log(
          JSON.stringify({
            route: scenario.id,
            case: scenario.name,
            chunks,
            error: error instanceof Error ? error.message : error,
            journal: mock.getRequests(),
            factories,
          }),
        );
        return { chunks, error };
      }
      const first = await turn();
      expect(mock.getRequests()).toHaveLength(1);
      expect(factories).toBe(1);
      expect(selectedCalls).toEqual(original);
      const entry = mock.getRequests()[0];
      if (!scenario.scoped && !scenario.sourceId && scenario.target === "second") {
        expect(entry.response.status).toBe(501);
        expect(first.error).toBeInstanceOf(Error);
        expect(entry.response.misbehavior).toMatchObject({
          reason: "not-applicable",
          evaluations: [{ reason: "not-applicable", outcome: "error" }],
        });
        expect(entry.response.misbehavior?.evaluations[0].ordinal).toBeUndefined();
      } else {
        expect(entry.response.status).toBe(200);
        expect(first.error).toBeUndefined();
        const expectedId =
          scenario.scoped || scenario.target === "first" ? "first_id" : "second_id";
        const calls = first.chunks.flatMap((chunk) => chunk.functionCalls ?? []);
        expect(calls.map((call) => ({ name: call.name, id: call.id }))).toEqual([
          { name: "first", id: expectedId },
          { name: "second", id: expectedId },
        ]);
        expect(entry.response.misbehavior?.servedToolCalls).toEqual([
          { name: "first", id: expectedId, arguments: '{"one":1}' },
          { name: "second", id: expectedId, arguments: '{"two":2}' },
        ]);
        expect(entry.response.misbehavior?.ordinal).toBe(0);
      }
      if (scenario.scoped) {
        expect(entry.response.misbehavior?.evaluations).toEqual([
          {
            entryIndex: 0,
            fault: "tool-call-id-duplicate",
            outcome: "skipped",
            reason: "not-applicable",
          },
          { entryIndex: 1, fault: "tool-call-id-duplicate", outcome: "applied", ordinal: 0 },
        ]);
        selectedCalls[1].id = "new_second";
        expect((await turn()).error).toBeUndefined();
        expect(mock.getRequests()[1].response.misbehavior?.evaluations).toEqual([
          { entryIndex: 0, fault: "tool-call-id-duplicate", outcome: "applied", ordinal: 0 },
        ]);
        expect((await turn()).error).toBeUndefined();
        expect(mock.getRequests()[2].response.misbehavior?.evaluations).toEqual([
          {
            entryIndex: 0,
            fault: "tool-call-id-duplicate",
            outcome: "skipped",
            reason: "times-exhausted",
          },
          {
            entryIndex: 1,
            fault: "tool-call-id-duplicate",
            outcome: "skipped",
            reason: "times-exhausted",
          },
        ]);
        expect(factories).toBe(3);
      }
    } finally {
      await mock.stop();
    }
  },
);
