import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { clearElevenLabsVoices, rememberElevenLabsVoice } from "../elevenlabs-voice.js";
import type { Fixture, RecordProviderKey } from "../types.js";
import {
  captureHttp,
  serializeGolden,
  startGoldenServer,
  startStubUpstream,
  type CapturedExchange,
  type GoldenServer,
} from "./golden/harness.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const files = [
  ["elevenlabs-audio.ts", 2, 4],
  ["elevenlabs-voice.ts", 4, 6],
  ["fal-audio.ts", 2, 4],
  ["speech.ts", 1, 2],
  ["transcription.ts", 1, 2],
  ["images.ts", 2, 4],
] as const;

function descendants(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    nodes.push(child, ...descendants(child));
  });
  return nodes;
}

describe("A6 source ownership", () => {
  it.each(files)("%s delegates its inventoried policy reads", (name, gates, journals) => {
    const path = join(sourceRoot, name);
    const program = ts.createProgram([path], { noResolve: true, noLib: true });
    const file = program.getSourceFile(path)!;
    const checker = program.getTypeChecker();
    function calls(owner: string, exported: string) {
      const symbols = file.statements.flatMap((statement) => {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
          return [];
        if (
          resolve(dirname(path), statement.moduleSpecifier.text.replace(/\.js$/, ".ts")) !==
          join(sourceRoot, owner)
        )
          return [];
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) return [];
        return bindings.elements
          .filter((binding) => (binding.propertyName ?? binding.name).text === exported)
          .map((binding) => checker.getSymbolAtLocation(binding.name));
      });
      return descendants(file).filter(
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          symbols.includes(checker.getSymbolAtLocation(node.expression)),
      );
    }
    expect(calls("helpers.ts", "resolveStrictMode")).toHaveLength(0);
    expect(calls("helpers.ts", "strictOverrideField")).toHaveLength(0);
    const decisions = calls("response/policy.ts", "resolveRequestDecisions");
    expect(decisions).toHaveLength(gates);
    expect(calls("response/policy.ts", "strictOverrideField")).toHaveLength(journals);
    for (const call of decisions) {
      expect(ts.isPropertyAccessExpression(call.parent)).toBe(true);
      if (ts.isPropertyAccessExpression(call.parent)) {
        expect(["fixtureMiss", "upstream"]).toContain(call.parent.name.text);
      }
      expect(call.arguments[0].getText(file)).toBe("defaults.strict");
      expect(["req.headers", "headers"]).toContain(call.arguments[1].getText(file));
    }
    const commonCopies = descendants(file).filter((node) => {
      if (!ts.isCallExpression(node) || node.expression.getText(file) !== "JSON.stringify")
        return false;
      const outer = node.arguments[0];
      if (!outer || !ts.isObjectLiteralExpression(outer) || outer.properties.length !== 1)
        return false;
      const error = outer.properties[0];
      if (!ts.isPropertyAssignment(error) || error.name.getText(file) !== "error") return false;
      if (!ts.isObjectLiteralExpression(error.initializer)) return false;
      const keys = error.initializer.properties.map((property) => property.name?.getText(file));
      const type = error.initializer.properties.find(
        (property) => property.name?.getText(file) === "type",
      );
      if (
        !type ||
        !ts.isPropertyAssignment(type) ||
        !ts.isStringLiteral(type.initializer) ||
        !["invalid_request_error", "server_error", "proxy_error"].includes(type.initializer.text)
      )
        return false;
      return (
        keys[0] === "message" &&
        keys[1] === "type" &&
        keys.every((key) => ["message", "type", "code"].includes(key ?? ""))
      );
    });
    expect(commonCopies, "common error envelopes belong to response/errors").toHaveLength(0);
    expect(calls("response/errors.ts", "renderError").length).toBeGreaterThan(0);
  });
});

function pin(id: string, value: unknown): void {
  const directory = process.env.A6_CAPTURE_DIR;
  if (!directory) return;
  const file = join(directory, `${id}.json`);
  const bytes = serializeGolden(value);
  if (process.env.A6_CAPTURE_WRITE === "1") {
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, bytes);
  } else expect(bytes, id).toBe(readFileSync(file, "utf8"));
}

function multipart(fields: Record<string, string>): RequestInit {
  const boundary = "a6-boundary";
  return {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body:
      Object.entries(fields)
        .map(
          ([key, value]) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
        )
        .join("") + `--${boundary}--\r\n`,
  };
}

interface Route {
  id: string;
  path: string;
  provider: RecordProviderKey;
  init: RequestInit;
  voiceSlot?: boolean;
  fixture?: Fixture;
}
function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
const routes: Route[] = [
  {
    id: "speech",
    path: "/v1/audio/speech",
    provider: "openai",
    init: json({ input: "a6" }),
    fixture: { match: { endpoint: "speech" }, response: { audio: "/wAB", format: "mp3" } },
  },
  {
    id: "transcription",
    path: "/v1/audio/transcriptions",
    provider: "openai",
    init: multipart({ model: "gpt-transcribe" }),
    fixture: {
      match: { endpoint: "transcription" },
      response: {
        transcription: { text: "a6 transcript", usage: { type: "duration", seconds: 3 } },
      },
    },
  },
  {
    id: "images",
    path: "/v1/images/generations",
    provider: "openai",
    init: json({ prompt: "a6" }),
    fixture: { match: { endpoint: "image" }, response: { image: { b64Json: "/wAB" } } },
  },
  {
    id: "image-edits",
    path: "/v1/images/edits",
    provider: "openai",
    init: multipart({ prompt: "a6" }),
    fixture: { match: { endpoint: "image" }, response: { image: { b64Json: "/wAB" } } },
  },
  {
    id: "eleven-tts",
    path: "/v1/text-to-speech/a6-voice",
    provider: "elevenlabs",
    init: json({ text: "a6" }),
    fixture: { match: { endpoint: "elevenlabs-tts" }, response: { audio: "/wAB", format: "mp3" } },
  },
  {
    id: "eleven-sound",
    path: "/v1/sound-generation",
    provider: "elevenlabs",
    init: json({ text: "a6" }),
    fixture: { match: { endpoint: "audio-gen" }, response: { audio: "/wAB", format: "mp3" } },
  },
  {
    id: "eleven-music",
    path: "/v1/music",
    provider: "elevenlabs",
    init: json({ prompt: "a6" }),
    fixture: { match: { endpoint: "audio-gen" }, response: { audio: "/wAB", format: "mp3" } },
  },
  {
    id: "fal-queue",
    path: "/fal/queue/submit/fal-ai/stable-audio",
    provider: "fal",
    init: json({ prompt: "a6" }),
  },
  {
    id: "fal-run",
    path: "/fal/run/fal-ai/stable-audio",
    provider: "fal",
    init: json({ prompt: "a6" }),
    fixture: { match: { endpoint: "fal-audio" }, response: { audio: "/wAB", format: "mp3" } },
  },
  {
    id: "voice-design",
    path: "/v1/text-to-voice/design",
    provider: "elevenlabs",
    init: json({ voice_description: "a6 voice description long enough", auto_generate_text: true }),
  },
  {
    id: "voice-create",
    path: "/v1/text-to-voice",
    provider: "elevenlabs",
    init: json({ voice_name: "a6", voice_description: "a6", generated_voice_id: "a6-preview" }),
  },
  {
    id: "voice-get",
    path: "/v1/voices/a6-voice",
    provider: "elevenlabs",
    init: { method: "GET" },
    voiceSlot: true,
  },
  {
    id: "voice-delete",
    path: "/v1/voices/a6-voice",
    provider: "elevenlabs",
    init: { method: "DELETE" },
    voiceSlot: true,
  },
];

function journal(server: GoldenServer) {
  return server.instance.journal.getAll().map((entry) => ({
    method: entry.method,
    path: entry.path,
    service: entry.service,
    body: entry.body,
    response: entry.response,
  }));
}

describe("A6 real HTTP policy preservation", () => {
  const policies = [
    { id: "default-loose", strict: false, header: undefined, refusal: false },
    { id: "default-strict", strict: true, header: undefined, refusal: true },
    { id: "header-true", strict: false, header: " TRUE ", refusal: true, override: true },
    { id: "header-false", strict: true, header: "0", refusal: false, override: false },
    { id: "invalid-strict", strict: true, header: "invalid", refusal: true },
    { id: "invalid-loose", strict: false, header: "invalid", refusal: false },
  ];
  it.each(
    routes.flatMap((route) =>
      policies.map((policy) => ({ route, policy, id: `${route.id}-${policy.id}` })),
    ),
  )("$id", async ({ route, policy, id }) => {
    clearElevenLabsVoices();
    const server = await startGoldenServer([], { strict: policy.strict });
    try {
      const headers = new Headers(route.init.headers);
      if (policy.header !== undefined) headers.set("x-aimock-strict", policy.header);
      const wire = await captureHttp(server.url + route.path, { ...route.init, headers });
      const entries = journal(server);
      expect(wire.status).toBe(
        policy.refusal
          ? 503
          : route.id === "voice-delete"
            ? 200
            : route.id === "voice-create"
              ? 200
              : 404,
      );
      expect(entries).toHaveLength(1);
      if (policy.override === undefined || (route.id === "voice-create" && !policy.refusal))
        expect(entries[0].response).not.toHaveProperty("strictOverride");
      else expect(entries[0].response.strictOverride).toBe(policy.override);
      pin(id, { wire, entries });
    } finally {
      await server.close();
      clearElevenLabsVoices();
    }
  });

  it.each(routes)("$id upstream hit/no-hit and headers", async (route) => {
    clearElevenLabsVoices();
    const upstream = await startStubUpstream((_request, response) => {
      response.writeHead(418, { "content-type": "application/json", "x-a6-upstream": "preserved" });
      response.end('{"a6":"upstream bytes"}');
    });
    const server = await startGoldenServer([], {
      strict: true,
      record: { providers: { [route.provider]: upstream.url }, proxyOnly: true },
    });
    try {
      const wires: CapturedExchange[] = [];
      for (const strict of ["true", "false"]) {
        const headers = new Headers(route.init.headers);
        headers.set("x-aimock-strict", strict);
        headers.set("x-a6-control", "forwarded");
        wires.push(await captureHttp(server.url + route.path, { ...route.init, headers }));
        expect(upstream.requests).toHaveLength(strict === "true" ? 0 : 1);
      }
      expect(wires[0].status).toBe(503);
      expect(wires[1].status).toBe(502);
      expect(wires[1].body).toBe(
        route.id === "fal-queue"
          ? '{"error":{"message":"Proxy to upstream failed: Submit 418: {\\"a6\\":\\"upstream bytes\\"}","type":"proxy_error"}}'
          : '{"a6":"upstream bytes"}',
      );
      expect(wires[1].headers["content-type"]).toBe("application/json");
      expect(upstream.requests[0].headers["x-a6-control"]).toBe("forwarded");
      expect(upstream.requests[0].headers).not.toHaveProperty("x-aimock-strict");
      pin(`${route.id}-proxy`, {
        wires,
        entries: journal(server),
        upstream: upstream.requests.map((request) => ({
          method: request.method,
          url: request.url,
          body: request.body,
          control: request.headers["x-a6-control"],
        })),
      });
    } finally {
      await server.close();
      await upstream.close();
      clearElevenLabsVoices();
    }
  });

  it.each(routes.filter((route) => route.fixture))(
    "$id fixture bytes and retry error",
    async (route) => {
      for (const error of [false, true]) {
        const fixture: Fixture = error
          ? {
              match: route.fixture!.match,
              response: {
                error: { message: "a6 fixture", type: "rate_limit_error", code: "a6_error" },
                status: 429,
                retryAfter: 7,
              },
            }
          : route.fixture!;
        const clock = vi.spyOn(Date, "now").mockReturnValue(1680000000000);
        const server = await startGoldenServer([fixture], { strict: true });
        try {
          const wire = await captureHttp(server.url + route.path, route.init);
          expect(wire.status).toBe(error ? 429 : 200);
          if (error) expect(wire.headers["retry-after"]).toBe("7");
          if (!error && ["speech", "eleven-tts", "eleven-sound", "eleven-music"].includes(route.id))
            expect(wire.bodyBase64).toBe("/wAB");
          pin(`${route.id}-fixture-${error ? "error" : "success"}`, {
            wire,
            entries: journal(server),
          });
        } finally {
          await server.close();
          clock.mockRestore();
        }
      }
    },
  );

  it.each(
    routes.filter(
      (route) =>
        route.init.headers &&
        new Headers(route.init.headers).get("content-type") === "application/json",
    ),
  )("$id validation envelopes", async (route) => {
    const server = await startGoldenServer([]);
    try {
      const wires: CapturedExchange[] = [];
      for (const body of ["{", "null", "{}"])
        wires.push(await captureHttp(server.url + route.path, { ...route.init, body }));
      expect(wires[0].status).toBe(400);
      expect(wires[1].status).toBe(400);
      pin(`${route.id}-validation`, { wires, entries: journal(server) });
    } finally {
      await server.close();
    }
  });

  it.each(routes.filter((route) => route.fixture))(
    "$id wrong response type envelope",
    async (route) => {
      const server = await startGoldenServer([
        { match: route.fixture!.match, response: { content: "unexpected" } },
      ]);
      try {
        const wire = await captureHttp(server.url + route.path, route.init);
        expect(wire.status).toBe(500);
        pin(`${route.id}-wrong-type`, { wire, entries: journal(server) });
      } finally {
        await server.close();
      }
    },
  );
});

describe("A6 voice read-point and transcription controls", () => {
  it.each([
    { id: "no-record", strict: false, record: false, source: "internal" },
    { id: "record-loose", strict: false, record: true, source: "proxy" },
    { id: "record-strict", strict: true, record: true, source: "internal" },
  ])("voice helper chaos source $id", async (control) => {
    clearElevenLabsVoices();
    const upstream = await startStubUpstream((_request, response) => {
      response.end("unused");
    });
    const server = await startGoldenServer([], {
      strict: control.strict,
      chaos: { rateLimitRate: 1 },
      ...(control.record
        ? { record: { providers: { elevenlabs: upstream.url }, proxyOnly: true } }
        : {}),
    });
    try {
      const route = routes.find((candidate) => candidate.id === "voice-design")!;
      const wire = await captureHttp(server.url + route.path, route.init);
      const entries = journal(server);
      expect(wire.status).toBe(429);
      expect(entries[0].response.source).toBe(control.source);
      expect(upstream.requests).toHaveLength(0);
      pin(`voice-helper-${control.id}`, { wire, entries });
    } finally {
      await server.close();
      await upstream.close();
      clearElevenLabsVoices();
    }
  });

  it("voice stored get/delete retain their separate journal resolutions", async () => {
    clearElevenLabsVoices();
    rememberElevenLabsVoice({ voice_id: "a6-voice", name: "a6" });
    const server = await startGoldenServer([], { strict: true });
    try {
      const wires: CapturedExchange[] = [];
      for (const method of ["GET", "DELETE"])
        wires.push(
          await captureHttp(server.url + "/v1/voices/a6-voice", {
            method,
            headers: { "x-aimock-strict": "false" },
          }),
        );
      const entries = journal(server);
      expect(wires.map((wire) => wire.status)).toEqual([200, 200]);
      expect(entries[0].response).not.toHaveProperty("strictOverride");
      expect(entries[1].response.strictOverride).toBe(false);
      pin("voice-stored", { wires, entries });
    } finally {
      await server.close();
      clearElevenLabsVoices();
    }
  });

  it.each(["json", "verbose_json", "stream", "translation"])(
    "transcription usage stays native: %s",
    async (mode) => {
      const endpoint = mode === "translation" ? "translation" : "transcription";
      const fixture: Fixture = {
        match: { endpoint },
        response: { transcription: { text: "a6", usage: { type: "duration", seconds: 3 } } },
      };
      const server = await startGoldenServer([fixture], { strict: true });
      try {
        const init = multipart({
          model: "gpt-transcribe",
          response_format: mode === "verbose_json" ? mode : "json",
          stream: mode === "stream" ? "true" : "false",
        });
        const wire = await captureHttp(
          server.url +
            (endpoint === "translation" ? "/v1/audio/translations" : "/v1/audio/transcriptions"),
          { ...init, ...(mode === "stream" ? { frames: "sse" as const } : {}) },
        );
        expect(wire.status).toBe(200);
        if (mode === "stream") expect(wire.frames?.at(-1)).toBe("data: [DONE]");
        else
          expect(JSON.parse(wire.body!).usage).toEqual(
            mode === "verbose_json" ? undefined : { type: "duration", seconds: 3 },
          );
        pin(`transcription-usage-${mode}`, { wire, entries: journal(server) });
      } finally {
        await server.close();
      }
    },
  );

  it("policy decisions are resolved again after mutable config changes", async () => {
    const server = await startGoldenServer([], { strict: false });
    try {
      const route = routes[0];
      const before = await captureHttp(server.url + route.path, route.init);
      Object.defineProperty(server.instance.defaults, "strict", { get: () => true });
      const after = await captureHttp(server.url + route.path, route.init);
      expect([before.status, after.status]).toEqual([404, 503]);
      pin("mutable-strict", { before, after, entries: journal(server) });
    } finally {
      await server.close();
    }
  });
});
