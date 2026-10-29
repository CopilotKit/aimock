import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import * as api from "../index.js";
import type { Fixture, FixtureModuleOptions } from "../index.js";

let dir: string;
let servers: api.LLMock[];
const load = (path: string, options?: FixtureModuleOptions): Fixture[] =>
  api.loadFixtureModule(path, options);
const p = (name: unknown) => ({ $param: name });
const entry = (text: unknown, content: unknown = "answer") => ({
  match: { userMessage: text },
  response: { content },
});
function file(name: string, content: unknown): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(content));
  return path;
}
const messages = (fixtures: Fixture[]) => fixtures.map((f) => f.match.userMessage);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aimock-modules-"));
  servers = [];
  expect(typeof api.loadFixtureModule).toBe("function");
  expect(typeof api.LLMock.prototype.loadFixtureModule).toBe("function");
});
afterEach(async () => {
  await Promise.all(servers.map((mock) => mock.stop()));
  rmSync(dir, { recursive: true, force: true });
});

describe("fixture modules", () => {
  it("exports a usable typed loader and chainable method", async () => {
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [
          "node_modules/typescript/bin/tsc",
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--target",
          "ES2022",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--resolveJsonModule",
          "src/__tests__/fixture-modules.types.ts",
        ]);
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 180000);
  it("expands nested includes at their positions, including repeats and diamonds", () => {
    file("shared.json", { fixtures: [entry("shared")] });
    file("left.json", { fixtures: [entry("left"), { include: "shared.json" }] });
    file("right.json", { fixtures: [{ include: "shared.json" }, entry("right")] });
    const root = file("root.json", {
      fixtures: [
        entry("first"),
        { include: "left.json" },
        { include: "right.json" },
        { include: "left.json" },
        entry("last"),
      ],
    });
    expect(messages(load(root))).toEqual([
      "first",
      "left",
      "shared",
      "shared",
      "right",
      "left",
      "shared",
      "last",
    ]);
  });

  it("resolves each path from its declaring file", () => {
    file("child.json", { fixtures: [entry("wrong")] });
    file("nested/child.json", { fixtures: [entry("right")] });
    file("nested/parent.json", { fixtures: [{ include: "./child.json" }] });
    const root = file("root.json", { fixtures: [{ include: "nested/parent.json" }] });
    expect(messages(load(root))).toEqual(["right"]);
  });

  it("applies defaults and root overrides by exact parameter name", () => {
    const path = file("root.json", {
      parameters: ["question", "answer"],
      defaults: { question: "default", answer: "default answer" },
      fixtures: [entry(p("question"), p("answer"))],
    });
    expect(load(path, { parameters: { question: "override" } })).toMatchObject([
      { match: { userMessage: "override" }, response: { content: "default answer" } },
    ]);
  });

  it("passes explicit parent expressions while retaining child defaults", () => {
    file("child.json", {
      parameters: ["question", "answer"],
      defaults: { question: "child", answer: "child answer" },
      fixtures: [entry(p("question"), p("answer"))],
    });
    const root = file("root.json", {
      parameters: ["question", "answer"],
      defaults: { question: "parent", answer: "parent answer" },
      fixtures: [
        { include: "child.json", with: { question: p("question") } },
        { include: "child.json" },
      ],
    });
    expect(load(root)).toMatchObject([
      { match: { userMessage: "parent" }, response: { content: "child answer" } },
      { match: { userMessage: "child" }, response: { content: "child answer" } },
    ]);
  });

  it("does not satisfy a child's required parameter from its parent implicitly", () => {
    file("child.json", { parameters: ["name"], fixtures: [entry(p("name"))] });
    const root = file("root.json", {
      parameters: ["name"],
      defaults: { name: "parent" },
      fixtures: [{ include: "child.json" }],
    });
    expect(() => load(root)).toThrow();
  });

  it("preserves JSON types before response normalization", () => {
    const path = file("root.json", {
      parameters: ["value"],
      fixtures: [
        {
          ...entry("structured"),
          response: {
            content: { nested: [p("value"), { number: 0, flag: false, empty: "", nil: null }] },
          },
        },
      ],
    });
    const value = { list: [1, false, null], nested: { a: "b" } };
    const response = load(path, { parameters: { value } })[0].response as { content: string };
    expect(JSON.parse(response.content)).toEqual({
      nested: [value, { number: 0, flag: false, empty: "", nil: null }],
    });
  });

  it("substitutes matches, options and tool arguments before their ordinary validation", () => {
    const path = file("root.json", {
      parameters: ["match", "count", "args"],
      fixtures: [
        {
          match: p("match"),
          response: { toolCalls: [{ name: "lookup", arguments: p("args") }] },
          chunkSize: p("count"),
        },
      ],
    });
    const fixtures = load(path, {
      parameters: { match: { userMessage: "lookup" }, count: 3, args: { id: 7 } },
    });
    expect(fixtures).toMatchObject([
      {
        match: { userMessage: "lookup" },
        chunkSize: 3,
        response: { toolCalls: [{ name: "lookup" }] },
      },
    ]);
    expect(
      JSON.parse(
        (fixtures[0].response as { toolCalls: { arguments: string }[] }).toolCalls[0].arguments,
      ),
    ).toEqual({ id: 7 });
  });

  it("copies inserted values without recursively interpreting their markers", () => {
    const path = file("root.json", {
      parameters: ["payload"],
      fixtures: [{ ...entry("q"), metadata: { inserted: p("payload") } }],
    });
    expect(load(path, { parameters: { payload: { $param: "undeclared" } } })[0].metadata).toEqual({
      inserted: { $param: "undeclared" },
    });
  });

  it.each(["direct", "include"])(
    "keeps nested inserted markers opaque and copies each occurrence through %s",
    (via) => {
      const fixture = {
        ...entry("q"),
        metadata: { first: p("payload"), second: p("payload") },
      };
      file("child.json", {
        parameters: ["payload", "replacement"],
        defaults: { replacement: "child replacement" },
        fixtures: [fixture],
      });
      const root = file("root.json", {
        parameters: ["payload", "replacement"],
        fixtures:
          via === "direct"
            ? [fixture]
            : [{ include: "child.json", with: { payload: p("payload") } }],
      });
      const payload = { nested: [{ $param: "replacement" }] };
      const metadata = load(root, {
        parameters: { payload, replacement: "parent replacement" },
      })[0].metadata as { first: typeof payload; second: typeof payload };
      expect(metadata).toEqual({ first: payload, second: payload });
      metadata.first.nested[0].$param = "mutated";
      expect(metadata.second).toEqual({ nested: [{ $param: "replacement" }] });
      expect(payload).toEqual({ nested: [{ $param: "replacement" }] });
    },
  );

  it("keeps strings, keys and marker objects with siblings literal", () => {
    const path = file("root.json", {
      fixtures: [
        { ...entry("${name}"), metadata: { $param: "missing", sibling: true, text: "{{name}}" } },
      ],
    });
    expect(load(path)[0]).toMatchObject({
      match: { userMessage: "${name}" },
      metadata: { $param: "missing", sibling: true, text: "{{name}}" },
    });
  });

  it("treats prototype-looking parameter names and JSON keys as ordinary own data", () => {
    const defaults = JSON.parse(
      '{"__proto__":{"__proto__":{"keep":true}},"constructor":false,"toString":null}',
    ) as Record<string, unknown>;
    const path = file("root.json", {
      parameters: Object.keys(defaults),
      defaults,
      fixtures: [
        {
          ...entry("q"),
          metadata: { payload: p("__proto__"), flag: p("constructor"), empty: p("toString") },
        },
      ],
    });
    expect(load(path)[0].metadata).toEqual({
      payload: defaults.__proto__,
      flag: false,
      empty: null,
    });
  });

  it.each([null, false, 0, "", [], {}])("accepts a supplied %j instead of the default", (value) => {
    const path = file("root.json", {
      parameters: ["value"],
      defaults: { value: "default" },
      fixtures: [{ ...entry("q"), metadata: { value: p("value") } }],
    });
    expect(load(path, { parameters: { value } })[0].metadata).toEqual({ value });
  });

  it.each([
    { parameters: ["unused"] },
    { parameters: [1], defaults: { "1": "value" } },
    { parameters: ["ok", null], defaults: { ok: "value", null: "value" } },
    { parameters: ["a", "a"], defaults: { a: 1 } },
    { parameters: [""] },
    { parameters: [" "] },
    { parameters: null },
    { parameters: "a" },
    { defaults: { undeclared: 1 } },
    { defaults: [] },
    { defaults: null },
  ])("rejects invalid declarations or incomplete bindings: %j", (shape) => {
    const path = file("root.json", { ...shape, fixtures: [entry("q")] });
    expect(() => load(path)).toThrow();
  });

  it.each(["root", "include"])(
    "rejects undeclared defaults even when all %s bindings are supplied",
    (via) => {
      const module = {
        parameters: ["declared"],
        defaults: { declared: "default", extra: "not declared" },
        fixtures: [entry("valid fixture")],
      };
      const child = file("child.json", module);
      const root = file("root.json", {
        fixtures: [{ include: "child.json", with: { declared: "supplied" } }],
      });
      expect(() =>
        via === "root" ? load(child, { parameters: { declared: "supplied" } }) : load(root),
      ).toThrow();
    },
  );

  it("rejects undeclared bindings at the root and at an include", () => {
    const child = file("child.json", { fixtures: [entry("q")] });
    expect(() => load(child, { parameters: { extra: 1 } })).toThrow();
    const root = file("root.json", { fixtures: [{ include: "child.json", with: { extra: 1 } }] });
    expect(() => load(root)).toThrow();
  });

  it("requires a root binding object rather than coercing other JSON values", () => {
    const path = file("root.json", { fixtures: [] });
    for (const parameters of [null, [], "", 0, false]) {
      expect(() => load(path, { parameters } as unknown as FixtureModuleOptions)).toThrow();
    }
  });

  it("appends on every call and keeps separate server instances independent", () => {
    const path = file("root.json", { fixtures: [entry("q")] });
    const first = new api.LLMock();
    const second = new api.LLMock();
    first.loadFixtureModule(path).loadFixtureModule(path);
    expect(messages([...first.getFixtures()])).toEqual(["q", "q"]);
    expect(second.getFixtures()).toEqual([]);
    second.loadFixtureModule(path);
    expect(messages([...second.getFixtures()])).toEqual(["q"]);
  });

  it.each(["missing", "", 1, null])("rejects an unresolved or malformed marker %j", (name) => {
    const path = file("root.json", {
      fixtures: [{ ...entry("q"), metadata: { marker: p(name) } }],
    });
    expect(() => load(path)).toThrow();
  });

  it.each([
    { include: "" },
    { include: 1 },
    { include: "child.json", with: [] },
    { include: "child.json", with: null },
    { include: "child.json", match: {} },
    { include: "child.json", extra: true },
    { include: "child.json", ...entry("ordinary") },
  ])("rejects malformed include directives: %j", (directive) => {
    file("child.json", { fixtures: [] });
    expect(() => load(file("root.json", { fixtures: [directive] }))).toThrow();
  });

  it("loads a nonempty whitespace-only include filename", () => {
    file(" ", { fixtures: [entry("space filename")] });
    const root = file("root.json", { fixtures: [{ include: " " }] });
    expect(messages(load(root))).toEqual(["space filename"]);
  });

  it("rejects cycles through aliases without treating sibling reuse as a cycle", () => {
    const root = file("root.json", { fixtures: [{ include: "alias.json" }] });
    symlinkSync(root, join(dir, "alias.json"));
    expect(() => load(root)).toThrow();
    file("root.json", { fixtures: [entry("fixed")] });
    expect(messages(load(root))).toEqual(["fixed"]);
  });

  it("detects mutual include cycles across parameter specializations", () => {
    file("a.json", { parameters: ["v"], fixtures: [{ include: "b.json", with: { v: 2 } }] });
    file("b.json", { parameters: ["v"], fixtures: [{ include: "a.json", with: { v: 3 } }] });
    expect(() => load(join(dir, "a.json"), { parameters: { v: 1 } })).toThrow();
  });

  it("preserves prior registrations across a late validation failure and permits repair", () => {
    const mock = new api.LLMock().on({ userMessage: "old" }, { content: "old answer" });
    const before = structuredClone(mock.getFixtures());
    const child = file("bad.json", { fixtures: [{ match: {}, response: {} }] });
    const root = file("root.json", { fixtures: [entry("valid"), { include: "bad.json" }] });
    expect(() => mock.loadFixtureModule(root)).toThrow();
    expect(mock.getFixtures()).toEqual(before);
    writeFileSync(child, JSON.stringify({ fixtures: [entry("repaired")] }));
    expect(mock.loadFixtureModule(root)).toBe(mock);
    expect(messages([...mock.getFixtures()])).toEqual(["old", "valid", "repaired"]);
  });

  it("rejects unreadable, invalid JSON and malformed child modules atomically", () => {
    const mock = new api.LLMock();
    const root = file("root.json", { fixtures: [entry("valid"), { include: "child.json" }] });
    for (const text of [undefined, "{", "null", "{}", '{"parameters":[]}', '{"fixtures":{}}']) {
      if (text !== undefined) writeFileSync(join(dir, "child.json"), text);
      expect(() => mock.loadFixtureModule(root)).toThrow();
      expect(mock.getFixtures()).toEqual([]);
    }
  });

  it("counts repeated occurrences at the fixture bound and rejects one over", () => {
    file("child.json", { fixtures: [entry("same")] });
    const root = file("root.json", {
      fixtures: [{ include: "child.json" }, { include: "child.json" }],
    });
    expect(load(root, { maxFixtures: 2 })).toHaveLength(2);
    expect(() => load(root, { maxFixtures: 1 })).toThrow();
    expect(load(root, { maxFixtures: Number.MAX_SAFE_INTEGER })).toHaveLength(2);
  });

  it("allows zero fixtures for empty modules but rejects the first occurrence", () => {
    file("child.json", { fixtures: [] });
    const root = file("root.json", { fixtures: [{ include: "child.json" }] });
    expect(load(root, { maxFixtures: 0 })).toEqual([]);
    file("child.json", { fixtures: [entry("first")] });
    expect(() => load(root, { maxFixtures: 0 })).toThrow();
  });

  it("counts root depth as zero and checks even empty includes", () => {
    file("leaf.json", { fixtures: [] });
    file("child.json", { fixtures: [{ include: "leaf.json" }] });
    const root = file("root.json", { fixtures: [{ include: "child.json" }] });
    expect(load(root, { maxDepth: 2 })).toEqual([]);
    expect(() => load(root, { maxDepth: 1 })).toThrow();
    expect(load(join(dir, "leaf.json"), { maxDepth: 0 })).toEqual([]);
    expect(() => load(root, { maxDepth: 0 })).toThrow();
    expect(load(root, { maxDepth: Number.MAX_SAFE_INTEGER })).toEqual([]);
  });

  it("enforces the documented default depth boundary", () => {
    for (let i = 0; i <= 65; i++)
      file(`${i}.json`, { fixtures: i === 65 ? [] : [{ include: `${i + 1}.json` }] });
    expect(load(join(dir, "1.json"))).toEqual([]);
    expect(() => load(join(dir, "0.json"))).toThrow();
  });

  it("enforces the documented default fixture boundary", () => {
    const path = file("root.json", {
      fixtures: Array.from({ length: 10000 }, (_, i) => entry(`q-${i}`)),
    });
    expect(load(path)).toHaveLength(10000);
    const value = JSON.parse(readFileSync(path, "utf8")) as { fixtures: unknown[] };
    value.fixtures.push(entry("extra"));
    writeFileSync(path, JSON.stringify(value));
    expect(() => load(path)).toThrow();
  }, 60000);

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "1", null])(
    "rejects invalid numeric limits [case %#]: %j",
    (value) => {
      const path = file("root.json", { fixtures: [] });
      for (const name of ["maxFixtures", "maxDepth"] as const) {
        expect(() => load(path, { [name]: value } as unknown as FixtureModuleOptions)).toThrow();
      }
    },
  );

  it.each([undefined, Infinity, NaN, () => "x", new Date(), 1n])(
    "rejects non-JSON parameter values [case %#]",
    (value) => {
      const path = file("root.json", { parameters: ["v"], fixtures: [] });
      expect(() =>
        load(path, { parameters: { v: value } } as unknown as FixtureModuleOptions),
      ).toThrow();
    },
  );

  it.each([
    { nested: Infinity },
    [undefined],
    { nested: [() => "x"] },
    [{ nested: 1n }],
    { nested: new Date() },
  ])("rejects nested non-JSON parameter values [case %#]", (value) => {
    const path = file("nested-invalid.json", { parameters: ["v"], fixtures: [] });
    expect(() =>
      load(path, { parameters: { v: value } } as unknown as FixtureModuleOptions),
    ).toThrow();
  });

  it("rejects sparse parameter arrays without coercing holes to null", () => {
    const path = file("root.json", {
      parameters: ["v"],
      fixtures: [{ ...entry("q"), metadata: { value: p("v") } }],
    });
    const hole = new Array<unknown>(1);
    for (const value of [hole, { nested: hole }, [hole]]) {
      const options = { parameters: { v: value } } as unknown as FixtureModuleOptions;
      expect(() => load(path, options)).toThrow();
      const mock = new api.LLMock().on({ userMessage: "old" }, { content: "old" });
      const before = structuredClone(mock.getFixtures());
      expect(() => mock.loadFixtureModule(path, options)).toThrow();
      expect(() => mock.mountFixtureModule("sparse", path, options)).toThrow();
      expect(mock.getFixtures()).toEqual(before);
      expect(mock.getFixtureModules()).toEqual([]);
    }
    expect(load(path, { parameters: { v: [null] } })[0].metadata).toEqual({ value: [null] });
  });

  it("rejects cyclic parameters but accepts shared noncyclic objects", () => {
    const path = file("root.json", {
      parameters: ["v"],
      fixtures: [{ ...entry("q"), metadata: { value: p("v") } }],
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => load(path, { parameters: { v: cycle } } as FixtureModuleOptions)).toThrow();
    const shared = { value: 1 };
    expect(load(path, { parameters: { v: [shared, shared] } })[0].metadata).toEqual({
      value: [shared, shared],
    });
  });

  it("returns independent ordinary fixture data across unchanged loads", () => {
    const path = file("ordinary.json", {
      fixtures: [{ ...entry("q"), metadata: { nested: { values: [1] } } }],
    });
    const first = load(path);
    const second = load(path);
    const values = (first[0].metadata as { nested: { values: number[] } }).nested.values;
    Reflect.set(values, "0", 99);
    expect(second[0].metadata).toEqual({ nested: { values: [1] } });
    expect(load(path)[0].metadata).toEqual({ nested: { values: [1] } });
  });

  it("detaches caller parameters, sibling expansions and subsequent loads", () => {
    file("child.json", {
      parameters: ["v"],
      fixtures: [{ ...entry("q"), metadata: { value: p("v") } }],
    });
    const path = file("root.json", {
      parameters: ["v"],
      fixtures: [
        { include: "child.json", with: { v: p("v") } },
        { include: "child.json", with: { v: p("v") } },
      ],
    });
    const supplied = { nested: [1] };
    const first = load(path, { parameters: { v: supplied } });
    supplied.nested.push(2);
    expect(first[0].metadata).toEqual({ value: { nested: [1] } });
    (first[0].metadata as { value: { nested: number[] } }).value.nested.push(3);
    expect(first[1].metadata).toEqual({ value: { nested: [1] } });
    expect(load(path, { parameters: { v: supplied } })[0].metadata).toEqual({
      value: { nested: [1, 2] },
    });
  });

  it("rereads repaired files and never rewrites their contents", () => {
    const path = file("root.json", { fixtures: [entry("first")] });
    const bytes = readFileSync(path);
    expect(messages(load(path))).toEqual(["first"]);
    expect(readFileSync(path)).toEqual(bytes);
    file("root.json", { fixtures: [entry("second")] });
    expect(messages(load(path))).toEqual(["second"]);
    file("child.json", { fixtures: [entry("child-before")] });
    const root = file("parent.json", { fixtures: [{ include: "child.json" }] });
    expect(messages(load(root))).toEqual(["child-before"]);
    file("child.json", { fixtures: [entry("child-after")] });
    expect(messages(load(root))).toEqual(["child-after"]);
  });

  it("appends atomically to a live server and preserves existing fixture precedence", async () => {
    const mock = new api.LLMock().on({ userMessage: "same" }, { content: "old" });
    const url = await mock.start();
    servers.push(mock);
    const path = file("root.json", {
      fixtures: [entry("same", "new"), entry("module only", "loaded")],
    });
    expect(mock.loadFixtureModule(path)).toBe(mock);
    for (const [question, answer] of [
      ["same", "old"],
      ["module only", "loaded"],
    ]) {
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "test", messages: [{ role: "user", content: question }] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ choices: [{ message: { content: answer } }] });
    }
  });
  it("forwards method parameters and both limits without weakening standalone behavior", () => {
    const child = file("child.json", { parameters: ["q"], fixtures: [entry(p("q"))] });
    const root = file("root.json", {
      parameters: ["q"],
      fixtures: [{ include: "child.json", with: { q: p("q") } }],
    });
    const mock = new api.LLMock();
    expect(
      mock.loadFixtureModule(root, { parameters: { q: "forwarded" }, maxDepth: 1, maxFixtures: 1 }),
    ).toBe(mock);
    expect(messages([...mock.getFixtures()])).toEqual(["forwarded"]);
    for (const options of [
      { parameters: { q: "x" }, maxDepth: 0 },
      { parameters: { q: "x" }, maxFixtures: 0 },
    ]) {
      expect(() => mock.loadFixtureModule(root, options)).toThrow();
      expect(messages([...mock.getFixtures()])).toEqual(["forwarded"]);
    }
    expect(() => mock.loadFixtureModule(child)).toThrow();
  });

  it("resolves markers nested inside child binding arrays and objects", () => {
    file("child.json", {
      parameters: ["payload"],
      fixtures: [{ ...entry("q"), metadata: { value: p("payload") } }],
    });
    const root = file("root.json", {
      parameters: ["value"],
      fixtures: [
        {
          include: "child.json",
          with: { payload: { nested: [p("value"), { inner: p("value") }] } },
        },
      ],
    });
    expect(load(root, { parameters: { value: false } })[0].metadata).toEqual({
      value: { nested: [false, { inner: false }] },
    });
  });

  it("substitutes ordinary fixture options as well as matching and response data", () => {
    const root = file("root.json", {
      parameters: ["delay", "truncate"],
      fixtures: [{ ...entry("q"), latency: p("delay"), truncateAfterChunks: p("truncate") }],
    });
    expect(load(root, { parameters: { delay: 0, truncate: 2 } })[0]).toMatchObject({
      latency: 0,
      truncateAfterChunks: 2,
    });
  });
});
