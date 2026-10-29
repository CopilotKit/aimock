import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { LLMock } from "../index.js";
import type { Fixture, FixtureModuleOptions, LiveFixtureResponse } from "../index.js";

let dir: string;
let servers: LLMock[];
const entry = (q: string, answer = q) => ({
  match: { userMessage: q },
  response: { content: answer },
});
const param = (name: string) => ({ $param: name });
function file(name: string, value: unknown): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  return path;
}
const questions = (mock: LLMock) => mock.getFixtures().map((f) => f.match.userMessage);
async function start(mock: LLMock): Promise<string> {
  servers.push(mock);
  return mock.start();
}
async function ask(url: string, q = "q") {
  const response = await fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", messages: [{ role: "user", content: q }] }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}
function liveRegistrationFixture(): Fixture & { response: LiveFixtureResponse } {
  const configuration = {
    model: "gpt-live-1",
    audio: { format: { type: "audio/pcm", rate: 24000 } },
    delegation: { type: "client" },
  };
  const session = { ...configuration, id: "session-1", expires_at: 123, status: "active" };
  return {
    match: { endpoint: "openai-live" },
    response: {
      live: {
        version: 1,
        model: "gpt-live-1",
        mode: "client",
        audio: { encoding: "pcm16le", sampleRateHz: 24000, channels: 1 },
        configuration,
        entries: [
          {
            direction: "client",
            atMs: 0,
            event: { type: "session.start", session: configuration },
          },
          {
            direction: "server",
            atMs: 1,
            barrier: { command: 1, audioBytes: 0 },
            event: { type: "session.started", event_id: "event-1", session },
          },
          { direction: "client", atMs: 2, event: { type: "session.close" } },
          {
            direction: "server",
            atMs: 3,
            barrier: { command: 2, audioBytes: 0 },
            event: {
              type: "session.closed",
              event_id: "event-2",
              session,
              usage: { seconds: 0 },
              reason: "close_requested",
            },
          },
        ],
        bindings: [
          { entry: 1, pointer: "/event_id", name: "event-1", owner: "server", action: "define" },
          {
            entry: 1,
            pointer: "/session/id",
            name: "session-1",
            owner: "server",
            action: "define",
          },
          { entry: 3, pointer: "/event_id", name: "event-2", owner: "server", action: "define" },
          {
            entry: 3,
            pointer: "/session/id",
            name: "session-1",
            owner: "server",
            action: "reference",
          },
        ],
        capture: { source: "authored", complete: true, terminalEntry: 3 },
      },
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aimock-module-lifecycle-"));
  servers = [];
  expect(typeof LLMock.prototype.mountFixtureModule).toBe("function");
  expect(typeof LLMock.prototype.reloadFixtureModules).toBe("function");
  expect(typeof LLMock.prototype.unmountFixtureModule).toBe("function");
  expect(typeof LLMock.prototype.getFixtureModules).toBe("function");
});
afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop()));
  rmSync(dir, { recursive: true, force: true });
});

describe("managed fixture modules", () => {
  it("validates enabled misbehavior before publishing a mounted module or reload", () => {
    const root = file("faults.json", { fixtures: [entry("stable")] });
    const mock = new LLMock({ enableMisbehavior: true });
    mock.mountFixtureModule("faults", root);
    file("faults.json", {
      fixtures: [{ ...entry("bad"), misbehavior: { faults: [{ fault: "unknown-fault" }] } }],
    });
    expect(() => mock.reloadFixtureModules()).toThrow("unknown-fault");
    expect(questions(mock)).toEqual(["stable"]);
    expect(mock.getFixtureModules()[0].revision).toBe(1);
    expect(() => mock.mountFixtureModule("another", root)).toThrow("unknown-fault");
    expect(mock.getFixtureModules()).toHaveLength(1);
    const disabled = new LLMock();
    expect(() => disabled.mountFixtureModule("faults", root)).not.toThrow();
  });

  it("captures absolute roots, resolved options and deduplicated canonical dependencies", () => {
    const leaf = file("leaf.json", { parameters: ["q"], fixtures: [entry("leaf")] });
    symlinkSync(leaf, join(dir, "alias.json"));
    const root = file("root.json", {
      fixtures: [
        { include: "leaf.json", with: { q: "one" } },
        { include: "alias.json", with: { q: "two" } },
      ],
    });
    const mock = new LLMock();
    expect(mock.getFixtureModules()).toEqual([]);
    expect(mock.mountFixtureModule("first", relative(process.cwd(), root))).toBe(mock);
    const info = mock.getFixtureModules();
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({
      name: "first",
      filePath: root,
      fixtureCount: 2,
      revision: 1,
      options: { parameters: {}, maxFixtures: 10000, maxDepth: 64 },
    });
    expect(new Set(info[0].files)).toEqual(new Set([realpathSync(root), realpathSync(leaf)]));
    expect(info[0].files).toHaveLength(2);
  });

  it("keeps empty module positions through remounts and preserves other registration paths", () => {
    const empty = file("empty.json", { fixtures: [] });
    const first = file("first.json", { fixtures: [entry("a1"), entry("a2")] });
    const second = file("second.json", { fixtures: [entry("b")] });
    const direct = file("direct.json", { fixtures: [entry("file")] });
    file("directory/part.json", { fixtures: [entry("dir")] });
    const mock = new LLMock().on({ userMessage: "before" }, { content: "before" });
    mock.mountFixtureModule("a", empty).addFixture(entry("middle")).mountFixtureModule("b", second);
    mock
      .addFixtures([entry("array")])
      .loadFixtureFile(direct)
      .loadFixtureDir(join(dir, "directory"));
    mock
      .addFixturesFromJSON([entry("json")])
      .loadFixtureModule(file("adhoc.json", { fixtures: [entry("adhoc")] }));
    mock.prependFixture(entry("front"));
    mock.mountFixtureModule("a", first);
    expect(questions(mock)).toEqual([
      "front",
      "before",
      "a1",
      "a2",
      "middle",
      "b",
      "array",
      "file",
      "dir",
      "json",
      "adhoc",
    ]);
    mock.mountFixtureModule("a", empty);
    expect(mock.getFixtureModules().map((m) => m.fixtureCount)).toEqual([0, 1]);
    mock.mountFixtureModule("a", first);
    expect(mock.getFixtureModules().map((m) => m.fixtureCount)).toEqual([2, 1]);
    expect(questions(mock)).toEqual([
      "front",
      "before",
      "a1",
      "a2",
      "middle",
      "b",
      "array",
      "file",
      "dir",
      "json",
      "adhoc",
    ]);
    expect(mock.getFixtureModules().map((m) => [m.name, m.revision])).toEqual([
      ["a", 4],
      ["b", 1],
    ]);
  });

  it("owns registrations rather than removing unrelated aliases of the same fixture", () => {
    const path = file("root.json", { fixtures: [entry("q")] });
    const mock = new LLMock().mountFixtureModule("module", path);
    mock.addFixture(mock.getFixtures()[0]);
    expect(mock.unmountFixtureModule("module")).toBe(true);
    expect(questions(mock)).toEqual(["q"]);
    expect(mock.unmountFixtureModule("module")).toBe(false);
  });

  it("validates exact names and permits independent prototype-looking names", () => {
    const path = file("root.json", { fixtures: [] });
    const mock = new LLMock();
    for (const name of ["a", " a", "A", "__proto__"]) mock.mountFixtureModule(name, path);
    expect(mock.getFixtureModules().map((m) => m.name)).toEqual(["a", " a", "A", "__proto__"]);
    for (const value of ["", "  ", null, 1]) {
      expect(() => mock.mountFixtureModule(value as string, path)).toThrow();
      expect(() => mock.unmountFixtureModule(value as string)).toThrow();
    }
    expect(mock.unmountFixtureModule("a")).toBe(true);
    expect(mock.getFixtureModules().map((m) => m.name)).toEqual([" a", "A", "__proto__"]);
  });

  it("keeps failed new mounts and replacements out of fixtures, dependencies and revisions", () => {
    const good = file("good.json", { fixtures: [entry("good")] });
    const bad = file("bad.json", {
      fixtures: [entry("valid-prefix"), { match: {}, response: {} }],
    });
    const mock = new LLMock().mountFixtureModule("a", good);
    const before = mock.getFixtureModules();
    for (const name of ["new", "a"]) {
      expect(() => mock.mountFixtureModule(name, bad)).toThrow();
      expect(mock.getFixtureModules()).toEqual(before);
      expect(questions(mock)).toEqual(["good"]);
    }
    file("bad.json", { fixtures: [entry("repaired")] });
    expect(mock.reloadFixtureModules([bad])).toBe(0);
    mock.mountFixtureModule("a", bad);
    expect(mock.getFixtureModules()[0].revision).toBe(2);
    expect(questions(mock)).toEqual(["repaired"]);
  });

  it("applies and retains parameter and limit options on mounted roots", () => {
    file("child.json", {
      parameters: ["q"],
      fixtures: [{ match: { userMessage: param("q") }, response: { content: "ok" } }],
    });
    const path = file("root.json", {
      parameters: ["q"],
      fixtures: [{ include: "child.json", with: { q: param("q") } }],
    });
    const mock = new LLMock().mountFixtureModule("a", path, {
      parameters: { q: "bound" },
      maxDepth: 1,
      maxFixtures: 1,
    });
    expect(questions(mock)).toEqual(["bound"]);
    for (const options of [
      { parameters: { q: "x" }, maxDepth: 0 },
      { parameters: { q: "x" }, maxFixtures: 0 },
    ]) {
      expect(() => mock.mountFixtureModule("a", path, options)).toThrow();
      expect(mock.getFixtureModules()[0].revision).toBe(1);
    }
    file("child.json", { parameters: ["q"], fixtures: [entry("one"), entry("two")] });
    expect(() => mock.reloadFixtureModules()).toThrow();
    expect(questions(mock)).toEqual(["bound"]);
  });

  it("selects each owner once through shared, empty and aliased dependencies", () => {
    const shared = file("shared.json", { fixtures: [] });
    symlinkSync(shared, join(dir, "alias.json"));
    const a = file("a.json", { fixtures: [entry("a"), { include: "shared.json" }] });
    const b = file("b.json", { fixtures: [{ include: "alias.json" }, entry("b")] });
    const c = file("c.json", { fixtures: [entry("c")] });
    const mock = new LLMock()
      .mountFixtureModule("a", a)
      .mountFixtureModule("b", b)
      .mountFixtureModule("c", c);
    file("shared.json", { fixtures: [entry("shared")] });
    expect(
      mock.reloadFixtureModules([relative(process.cwd(), shared), shared, join(dir, "alias.json")]),
    ).toBe(2);
    expect(questions(mock)).toEqual(["a", "shared", "shared", "b", "c"]);
    expect(mock.getFixtureModules().map((m) => m.revision)).toEqual([2, 2, 1]);
    expect(mock.getFixtureModules().map((m) => m.fixtureCount)).toEqual([2, 2, 1]);
    expect(mock.reloadFixtureModules([join(dir, "alias.json")])).toBe(2);
    expect(mock.getFixtureModules().map((m) => m.revision)).toEqual([3, 3, 1]);
  });

  it("selects dependencies using only a path relative to the working directory", () => {
    const child = file("nested/child.json", { fixtures: [entry("old")] });
    const root = file("nested/root.json", { fixtures: [{ include: "child.json" }] });
    const mock = new LLMock().mountFixtureModule("group", root);
    file("nested/child.json", { fixtures: [entry("updated")] });
    expect(mock.reloadFixtureModules([relative(process.cwd(), child)])).toBe(1);
    expect(questions(mock)).toEqual(["updated"]);
    expect(mock.getFixtureModules()[0].revision).toBe(2);
  });

  it.each(["root", "include"])(
    "remembers a deleted %s symlink path and repairs its dependency set",
    (via) => {
      const old = file("old.json", { fixtures: [entry("old")] });
      const next = file("next.json", { fixtures: [entry("repaired")] });
      const alias = join(dir, "alias.json");
      symlinkSync(old, alias);
      const root =
        via === "root" ? alias : file("root.json", { fixtures: [{ include: "alias.json" }] });
      const mock = new LLMock().mountFixtureModule("group", root);
      const before = mock.getFixtureModules();
      rmSync(alias);
      expect(() => mock.reloadFixtureModules([relative(process.cwd(), alias)])).toThrow();
      expect(mock.getFixtureModules()).toEqual(before);
      expect(questions(mock)).toEqual(["old"]);
      symlinkSync(next, alias);
      expect(mock.reloadFixtureModules([alias])).toBe(1);
      expect(questions(mock)).toEqual(["repaired"]);
      expect(mock.getFixtureModules()[0].revision).toBe(2);
      const files =
        via === "root" ? [realpathSync(next)] : [realpathSync(root), realpathSync(next)];
      expect(new Set(mock.getFixtureModules()[0].files)).toEqual(new Set(files));
      expect(mock.reloadFixtureModules([old])).toBe(0);
      expect(mock.getFixtureModules()[0].revision).toBe(2);
    },
  );

  it("distinguishes omitted paths from an empty list and validates even without mounts", () => {
    const path = file("root.json", { fixtures: [] });
    const mock = new LLMock().mountFixtureModule("empty", path);
    expect(mock.reloadFixtureModules([])).toBe(0);
    expect(mock.getFixtureModules()[0].revision).toBe(1);
    expect(mock.reloadFixtureModules()).toBe(1);
    expect(mock.reloadFixtureModules()).toBe(1);
    expect(mock.getFixtureModules()[0].revision).toBe(3);
    rmSync(path);
    expect(mock.reloadFixtureModules([])).toBe(0);
    const fresh = new LLMock();
    const before = mock.getFixtureModules();
    for (const paths of [null, "root.json", [""], [1], new Array<string>(1)]) {
      expect(() => fresh.reloadFixtureModules(paths as string[])).toThrow();
      expect(() => mock.reloadFixtureModules(paths as string[])).toThrow();
      expect(mock.getFixtureModules()).toEqual(before);
    }
  });

  it("accepts a whitespace-only changed path without selecting unrelated groups", () => {
    const root = file("root.json", { fixtures: [entry("retained")] });
    const mock = new LLMock().mountFixtureModule("group", root);
    const before = mock.getFixtureModules();
    expect(mock.reloadFixtureModules([" "])).toBe(0);
    expect(mock.getFixtureModules()).toEqual(before);
    expect(questions(mock)).toEqual(["retained"]);
    expect(new LLMock().reloadFixtureModules([" "])).toBe(0);
  });

  it("selects deleted dependencies and permits repair without losing the last successful state", () => {
    const child = file("child.json", { fixtures: [entry("old")] });
    const root = file("root.json", { fixtures: [{ include: "child.json" }] });
    const mock = new LLMock().mountFixtureModule("a", root);
    const before = mock.getFixtureModules();
    rmSync(child);
    expect(() => mock.reloadFixtureModules([child])).toThrow();
    expect(mock.getFixtureModules()).toEqual(before);
    expect(questions(mock)).toEqual(["old"]);
    file("child.json", { fixtures: [entry("new")] });
    expect(mock.reloadFixtureModules([child])).toBe(1);
    expect(questions(mock)).toEqual(["new"]);
    const repaired = mock.getFixtureModules();
    rmSync(root);
    expect(() => mock.reloadFixtureModules([root])).toThrow();
    expect(mock.getFixtureModules()).toEqual(repaired);
    expect(questions(mock)).toEqual(["new"]);
    file("root.json", { fixtures: [{ include: "child.json" }] });
    expect(mock.reloadFixtureModules([root])).toBe(1);
    expect(mock.getFixtureModules()[0].revision).toBe(3);
  });

  it("replaces successful dependency sets rather than retaining obsolete files", () => {
    const old = file("old.json", { fixtures: [entry("old")] });
    const next = file("next.json", { fixtures: [entry("next")] });
    const root = file("root.json", { fixtures: [{ include: "old.json" }] });
    const mock = new LLMock().mountFixtureModule("a", root);
    file("root.json", { fixtures: [{ include: "next.json" }] });
    expect(mock.reloadFixtureModules([root])).toBe(1);
    rmSync(old);
    expect(mock.reloadFixtureModules([old])).toBe(0);
    expect(new Set(mock.getFixtureModules()[0].files)).toEqual(
      new Set([realpathSync(root), realpathSync(next)]),
    );
    file("next.json", { fixtures: [entry("changed")] });
    expect(mock.reloadFixtureModules([next])).toBe(1);
    expect(questions(mock)).toEqual(["changed"]);
  });

  it("rolls back all selected roots, revisions and dependencies after a late failure", () => {
    const old = file("old.json", { fixtures: [entry("old")] });
    const next = file("next.json", { fixtures: [entry("next")] });
    const a = file("a.json", { fixtures: [{ include: "old.json" }] });
    const b = file("b.json", { fixtures: [entry("b")] });
    const mock = new LLMock().mountFixtureModule("a", a).mountFixtureModule("b", b);
    const before = mock.getFixtureModules();
    file("a.json", { fixtures: [{ include: "next.json" }] });
    file("b.json", { fixtures: [{ match: {}, response: {} }] });
    expect(() => mock.reloadFixtureModules()).toThrow();
    expect(mock.getFixtureModules()).toEqual(before);
    expect(questions(mock)).toEqual(["old", "b"]);
    expect(mock.reloadFixtureModules([next])).toBe(0);
    expect(mock.reloadFixtureModules([old])).toBe(1);
    expect(questions(mock)).toEqual(["next", "b"]);
    file("b.json", { fixtures: [entry("fixed")] });
    expect(mock.reloadFixtureModules()).toBe(2);
    expect(mock.getFixtureModules().map((m) => m.revision)).toEqual([3, 2]);
  });

  it("isolates captured options and returned module snapshots from future reloads", () => {
    const path = file("root.json", {
      parameters: ["v"],
      fixtures: [{ ...entry("q"), metadata: { value: param("v") } }],
    });
    const options: FixtureModuleOptions = {
      parameters: { v: { nested: [1] } },
      maxFixtures: 1,
      maxDepth: 0,
    };
    const mock = new LLMock().mountFixtureModule("a", path, options);
    options.parameters = { v: "caller edit" };
    options.maxFixtures = 0;
    const before = mock.getFixtureModules();
    const info = mock.getFixtureModules();
    // Detached snapshots may be mutable or frozen; neither can alter the registry.
    Reflect.set((info[0].options.parameters.v as { nested: number[] }).nested, "1", 2);
    Reflect.set(info[0].options, "maxFixtures", 0);
    Reflect.set(info[0].files, "length", 0);
    Reflect.set(info[0], "revision", 999);
    expect(mock.getFixtureModules()).toEqual(before);
    expect(mock.reloadFixtureModules([path])).toBe(1);
    expect(mock.getFixtures()[0].metadata).toEqual({ value: { nested: [1] } });
    expect(mock.getFixtureModules()[0]).toMatchObject({ revision: 2, options: { maxFixtures: 1 } });
    expect(mock.getFixtureModules()[0].files).toEqual([realpathSync(path)]);
  });

  it("forgets unmounted empty groups and restarts their revision and position on remount", () => {
    const path = file("empty.json", { fixtures: [] });
    const other = file("other.json", { fixtures: [entry("other")] });
    const mock = new LLMock().mountFixtureModule("empty", path).mountFixtureModule("other", other);
    expect(mock.reloadFixtureModules()).toBe(2);
    expect(mock.unmountFixtureModule("empty")).toBe(true);
    expect(mock.unmountFixtureModule("empty")).toBe(false);
    file("empty.json", { fixtures: [entry("returned")] });
    mock.mountFixtureModule("empty", path);
    expect(questions(mock)).toEqual(["other", "returned"]);
    expect(mock.getFixtureModules().map((m) => [m.name, m.revision])).toEqual([
      ["other", 2],
      ["empty", 1],
    ]);
  });

  it.each(["clearFixtures", "reset"] as const)(
    "forgets ownership through %s and isolates instances",
    (method) => {
      const path = file("root.json", { fixtures: [entry("q")] });
      const first = new LLMock().mountFixtureModule("a", path);
      const second = new LLMock().mountFixtureModule("a", path);
      expect(first[method]()).toBe(first);
      rmSync(path);
      expect(first.getFixtureModules()).toEqual([]);
      expect(first.reloadFixtureModules()).toBe(0);
      expect(first.unmountFixtureModule("a")).toBe(false);
      expect(questions(second)).toEqual(["q"]);
      expect(second.getFixtureModules()[0].revision).toBe(1);
    },
  );

  it.each([
    ["DELETE", "/__aimock/fixtures"],
    ["POST", "/__aimock/reset"],
  ])("forgets mounts through HTTP %s %s", async (method, route) => {
    const path = file("root.json", { fixtures: [] });
    const mock = new LLMock().mountFixtureModule("empty", path);
    const url = await start(mock);
    expect((await fetch(url + route, { method })).status).toBe(200);
    rmSync(path);
    expect(mock.getFixtureModules()).toEqual([]);
    expect(mock.reloadFixtureModules()).toBe(0);
  });

  it("updates the running server and preserves fixtures appended through HTTP", async () => {
    const path = file("root.json", { fixtures: [entry("q", "old")] });
    const mock = new LLMock().mountFixtureModule("a", path);
    const url = await start(mock);
    const added = await fetch(url + "/__aimock/fixtures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixtures: [entry("http", "kept")] }),
    });
    expect(added.status).toBe(200);
    file("root.json", { fixtures: [entry("q", "new")] });
    expect(mock.reloadFixtureModules()).toBe(1);
    expect(await ask(url)).toMatchObject({
      status: 200,
      body: { choices: [{ message: { content: "new" } }] },
    });
    expect(await ask(url, "http")).toMatchObject({
      status: 200,
      body: { choices: [{ message: { content: "kept" } }] },
    });
    mock.unmountFixtureModule("a");
    expect(questions(mock)).toEqual(["http"]);
  });

  it("retains one-shot precedence and consumes injections only once across reload and unmount", async () => {
    const path = file("root.json", { fixtures: [entry("q", "old")] });
    const mock = new LLMock().nextRequestError(503).mountFixtureModule("a", path);
    mock.prependFixture(entry("priority", "first"));
    const url = await start(mock);
    file("root.json", { fixtures: [entry("q", "new")] });
    mock.reloadFixtureModules();
    expect(await ask(url, "priority")).toMatchObject({
      status: 200,
      body: { choices: [{ message: { content: "first" } }] },
    });
    expect((await ask(url)).status).toBe(503);
    mock.reloadFixtureModules();
    expect(await ask(url)).toMatchObject({
      status: 200,
      body: { choices: [{ message: { content: "new" } }] },
    });
    mock.nextRequestError(502);
    mock.unmountFixtureModule("a");
    expect((await ask(url)).status).toBe(502);
    mock.mountFixtureModule("a", path);
    expect((await ask(url)).status).toBe(200);
  });
  it("failed prepend normalization leaves mounted ownership unchanged", () => {
    const path = file("root.json", { fixtures: [entry("module")] });
    const mock = new LLMock({ live: { maxDurationMs: 2 } }).mountFixtureModule("a", path);
    const before = structuredClone(mock.getFixtures());
    const info = mock.getFixtureModules();
    expect(() => mock.prependFixture(liveRegistrationFixture())).toThrow();
    expect(mock.getFixtures()).toEqual(before);
    expect(mock.getFixtureModules()).toEqual(info);
    expect(mock.unmountFixtureModule("a")).toBe(true);
    expect(mock.getFixtures()).toEqual([]);
    expect(mock.getFixtureModules()).toEqual([]);
    expect(mock.mountFixtureModule("a", path)).toBe(mock);
    expect(questions(mock)).toEqual(["module"]);
    expect(mock.getFixtureModules()[0].revision).toBe(1);
  });

  it.each(["method", "http"])(
    "retains empty group positions after a %s one-shot is consumed",
    async (via) => {
      const empty = file("empty.json", { fixtures: [] });
      const other = file("other.json", { fixtures: [entry("other")] });
      const mock = new LLMock()
        .mountFixtureModule("empty", empty)
        .mountFixtureModule("other", other);
      const url = await start(mock);
      if (via === "method") {
        mock.nextRequestError(503);
      } else {
        const response = await fetch(url + "/__aimock/error", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: 503 }),
        });
        expect(response.status).toBe(200);
        await response.json();
      }
      expect((await ask(url, "other")).status).toBe(503);
      expect((await ask(url, "other")).status).toBe(200);
      file("empty.json", { fixtures: [entry("returned")] });
      mock.mountFixtureModule("empty", empty);
      expect(questions(mock)).toEqual(["returned", "other"]);
      expect(mock.unmountFixtureModule("empty")).toBe(true);
      expect(questions(mock)).toEqual(["other"]);
    },
  );

  it.each(
    ["method", "http"].flatMap((via) =>
      ["remount", "reload"].flatMap((operation) =>
        [false, true].map((following) => ({ via, operation, following })),
      ),
    ),
  )(
    "keeps a $via one-shot ahead of an empty group during $operation (following fixture: $following)",
    async ({ via, operation, following }) => {
      const path = file("empty.json", { fixtures: [] });
      const mock = new LLMock().mountFixtureModule("empty", path);
      if (following) mock.addFixture(entry("other"));
      const url = await start(mock);
      if (via === "method") {
        mock.nextRequestError(502);
      } else {
        const queued = await fetch(url + "/__aimock/error", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: 502 }),
        });
        expect(queued.status).toBe(200);
        await queued.json();
      }
      file("empty.json", { fixtures: [entry("returned")] });
      if (operation === "remount") mock.mountFixtureModule("empty", path);
      else expect(mock.reloadFixtureModules()).toBe(1);
      expect((await ask(url, "returned")).status).toBe(502);
      expect((await ask(url, "returned")).status).toBe(200);
      expect(questions(mock)).toEqual(following ? ["returned", "other"] : ["returned"]);
      expect(mock.getFixtureModules()[0].revision).toBe(2);
      expect(mock.unmountFixtureModule("empty")).toBe(true);
      expect(questions(mock)).toEqual(following ? ["other"] : []);
    },
  );

  it("applies existing server Live limits on module load, mount and reload", () => {
    const fixture = liveRegistrationFixture();
    const path = file("live.json", { fixtures: [fixture] });
    expect(() => new LLMock({ live: { maxDurationMs: 2 } }).loadFixtureFile(path)).toThrow();
    const direct = new LLMock({ live: { maxDurationMs: 3 } }).loadFixtureModule(path);
    expect(direct.getFixtures()).toHaveLength(1);
    const limited = new LLMock({ live: { maxDurationMs: 2 } });
    expect(() => limited.loadFixtureModule(path)).toThrow();
    expect(() => limited.mountFixtureModule("live", path)).toThrow();
    expect(limited.getFixtures()).toEqual([]);
    expect(limited.getFixtureModules()).toEqual([]);
    const mounted = new LLMock({ live: { maxDurationMs: 3 } }).mountFixtureModule("live", path);
    const before = structuredClone(mounted.getFixtures());
    const info = mounted.getFixtureModules();
    fixture.response.live.entries[3].atMs = 4;
    file("live.json", { fixtures: [fixture] });
    expect(() => mounted.reloadFixtureModules()).toThrow();
    expect(mounted.getFixtures()).toEqual(before);
    expect(mounted.getFixtureModules()).toEqual(info);
  });
});
