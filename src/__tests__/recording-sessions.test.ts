import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { LLMock, DEFAULT_TEST_ID, type RecordingSession } from "../index.js";
import type { MockServerOptions, RecordConfig } from "../types.js";

const storageObserver = vi.hoisted(() => ({
  afterMutation: undefined as (() => void) | undefined,
  afterDataWrite: undefined as (() => void) | undefined,
  beforeRename: undefined as ((source: unknown, destination: unknown) => void) | undefined,
  beforeWrite: undefined as ((target: unknown) => void) | undefined,
  targets: new Map<number, unknown>(),
  restore: [] as Array<() => void>,
  observing: false,
  checkWrite(target: unknown): void {
    const descriptor =
      typeof target === "number"
        ? target
        : target !== null &&
            typeof target === "object" &&
            "fd" in target &&
            typeof target.fd === "number"
          ? target.fd
          : undefined;
    this.beforeWrite?.(descriptor === undefined ? target : this.targets.get(descriptor));
  },
  checkOpen(target: unknown, flags: unknown, writeFlags: number): void {
    if (
      (typeof flags === "string" && /[wa+]/.test(flags)) ||
      (typeof flags === "number" && (flags & writeFlags) !== 0)
    )
      this.checkWrite(target);
  },
  notify(): void {
    if (this.observing) return;
    this.observing = true;
    try {
      this.afterMutation?.();
    } finally {
      this.observing = false;
    }
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const { writeFile, rename, open, constants } = fs;
  const observed = {
    ...fs,
    async writeFile(...args: Parameters<typeof fs.writeFile>) {
      storageObserver.checkWrite(args[0]);
      await writeFile(...args);
      storageObserver.afterDataWrite?.();
      storageObserver.notify();
    },
    async rename(...args: Parameters<typeof fs.rename>) {
      storageObserver.beforeRename?.(...args);
      await rename(...args);
      storageObserver.notify();
    },
    async open(...args: Parameters<typeof fs.open>) {
      storageObserver.checkOpen(
        args[0],
        args[1],
        constants.O_WRONLY |
          constants.O_RDWR |
          constants.O_CREAT |
          constants.O_TRUNC |
          constants.O_APPEND,
      );
      const handle = await open(...args);
      const descriptor = handle.fd;
      storageObserver.targets.set(descriptor, args[0]);
      for (const key of ["writeFile", "write", "writev", "truncate", "close"] as const) {
        const operation = handle[key];
        Object.defineProperty(handle, key, {
          configurable: true,
          writable: true,
          value: async (...values: unknown[]) => {
            if (key !== "close") storageObserver.checkWrite(descriptor);
            const result = await Reflect.apply(operation, handle, values);
            if (key === "writeFile" || key === "write" || key === "writev")
              storageObserver.afterDataWrite?.();
            if (key === "close") storageObserver.targets.delete(descriptor);
            storageObserver.notify();
            return result;
          },
        });
      }
      return handle;
    },
  };
  const { createRequire } = await import("node:module");
  const native = createRequire(import.meta.url)("node:fs/promises") as typeof fs;
  for (const key of ["appendFile", "copyFile", "link"] as const) {
    const operation = fs[key];
    Object.defineProperty(observed, key, {
      value: async (...args: unknown[]) => {
        storageObserver.checkWrite(args[key === "appendFile" ? 0 : 1]);
        const result = await Reflect.apply(operation, fs, args);
        storageObserver.notify();
        return result;
      },
    });
  }
  const keys = ["writeFile", "rename", "open", "appendFile", "copyFile", "link"] as const;
  const original = Object.fromEntries(keys.map((key) => [key, native[key]]));
  Object.assign(native, Object.fromEntries(keys.map((key) => [key, observed[key]])));
  storageObserver.restore.push(() => Object.assign(native, original));
  return { ...observed, default: observed };
});

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const { writeFileSync: writeSync, renameSync: moveSync, openSync, open } = fs;
  const beforeOpen = (...args: unknown[]) =>
    storageObserver.checkOpen(
      args[0],
      args[1],
      fs.constants.O_WRONLY |
        fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_TRUNC |
        fs.constants.O_APPEND,
    );
  const observeCallback =
    (
      operation: (...args: never[]) => unknown,
      before?: (...args: unknown[]) => void,
      after?: (args: unknown[], values: unknown[]) => void,
    ) =>
    (...args: unknown[]) => {
      const callback = args.at(-1);
      try {
        before?.(...args);
      } catch (error) {
        if (typeof callback !== "function") throw error;
        queueMicrotask(() => Reflect.apply(callback, undefined, [error]));
        return;
      }
      if (typeof callback === "function") {
        args[args.length - 1] = (...values: unknown[]) => {
          try {
            after?.(args, values);
          } catch (error) {
            return Reflect.apply(callback, undefined, [error]);
          }
          storageObserver.notify();
          return Reflect.apply(callback, undefined, values);
        };
      }
      return Reflect.apply(operation, fs, args);
    };
  const observed = {
    ...fs,
    promises: await import("node:fs/promises"),
    writeFile: observeCallback(
      fs.writeFile,
      (...args) => storageObserver.checkWrite(args[0]),
      (_args, values) => {
        if (!values[0]) storageObserver.afterDataWrite?.();
      },
    ),
    open: observeCallback(open, beforeOpen, (args, values) => {
      if (!values[0] && typeof values[1] === "number")
        storageObserver.targets.set(values[1], args[0]);
    }),
    openSync(...args: Parameters<typeof fs.openSync>) {
      beforeOpen(...args);
      const descriptor = openSync(...args);
      storageObserver.targets.set(descriptor, args[0]);
      return descriptor;
    },
    rename: observeCallback(fs.rename, (...args) =>
      storageObserver.beforeRename?.(args[0], args[1]),
    ),
    writeFileSync(...args: Parameters<typeof fs.writeFileSync>) {
      storageObserver.checkWrite(args[0]);
      writeSync(...args);
      storageObserver.afterDataWrite?.();
      storageObserver.notify();
    },
    renameSync(...args: Parameters<typeof fs.renameSync>) {
      storageObserver.beforeRename?.(...args);
      moveSync(...args);
      storageObserver.notify();
    },
  };
  const { createRequire } = await import("node:module");
  const native = createRequire(import.meta.url)("node:fs") as typeof fs;
  const syncKeys = [
    "writeSync",
    "writevSync",
    "appendFileSync",
    "copyFileSync",
    "linkSync",
    "closeSync",
  ] as const;
  const callbackKeys = ["write", "writev", "appendFile", "copyFile", "link", "close"] as const;
  for (const key of syncKeys) {
    const operation = fs[key];
    Object.defineProperty(observed, key, {
      value: (...args: unknown[]) => {
        if (key !== "closeSync")
          storageObserver.checkWrite(args[key === "copyFileSync" || key === "linkSync" ? 1 : 0]);
        const result = Reflect.apply(operation, fs, args);
        if (key === "writeSync" || key === "writevSync" || key === "appendFileSync")
          storageObserver.afterDataWrite?.();
        if (key === "closeSync" && typeof args[0] === "number")
          storageObserver.targets.delete(args[0]);
        storageObserver.notify();
        return result;
      },
    });
  }
  for (const key of callbackKeys) {
    Object.defineProperty(observed, key, {
      value: observeCallback(
        fs[key],
        (...args) => {
          if (key !== "close")
            storageObserver.checkWrite(args[key === "copyFile" || key === "link" ? 1 : 0]);
        },
        (args, values) => {
          if (!values[0] && (key === "write" || key === "writev" || key === "appendFile"))
            storageObserver.afterDataWrite?.();
          if (key === "close" && !values[0] && typeof args[0] === "number")
            storageObserver.targets.delete(args[0]);
        },
      ),
    });
  }
  const keys = [
    "writeFile",
    "rename",
    "writeFileSync",
    "renameSync",
    "open",
    "openSync",
    ...syncKeys,
    ...callbackKeys,
  ] as const;
  const original = Object.fromEntries(keys.map((key) => [key, native[key]]));
  Object.assign(native, Object.fromEntries(keys.map((key) => [key, observed[key]])));
  storageObserver.restore.push(() => Object.assign(native, original));
  return { ...observed, default: observed };
});

afterAll(() => {
  for (const restore of storageObserver.restore.splice(0).reverse()) restore();
});

const mocks: LLMock[] = [];
const servers: http.Server[] = [];
const directories: string[] = [];
const releases: Array<() => void> = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  storageObserver.afterMutation = undefined;
  storageObserver.afterDataWrite = undefined;
  storageObserver.beforeRename = undefined;
  storageObserver.beforeWrite = undefined;
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await exited;
    }
  }
  for (const release of releases.splice(0)) release();
  for (const mock of mocks.splice(0).reverse()) {
    try {
      await mock.stop();
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "Server not started") throw e;
    }
  }
  for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  storageObserver.targets.clear();
});

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "recording-session-"));
  directories.push(dir);
  return dir;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function processWriter(
  path: string,
  upstream: string,
  prompt: string,
  barrier: { arrived: () => void; released: Promise<void> },
) {
  return new Promise<number>((resolve, reject) => {
    const child = fork(
      fileURLToPath(new URL("./recording-writer.ts", import.meta.url)),
      [path, upstream, prompt],
      { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    children.push(child);
    let diagnostics = "";
    let count: number | undefined;
    child.stdout?.on("data", (data) => {
      diagnostics += data.toString();
    });
    child.stderr?.on("data", (data) => {
      diagnostics += data.toString();
    });
    child.on("error", reject);
    child.on("message", (message) => {
      if (typeof message === "number") count = message;
      if (message === "ready") {
        barrier.arrived();
        void barrier.released.then(() => {
          child.send("commit", (error: Error | null) => {
            if (error) reject(error);
          });
        });
      }
    });
    child.on("exit", (code, signal) => {
      if (code === 0 && count !== undefined) resolve(count);
      else reject(new Error(`Recording writer exited ${code ?? signal}: ${diagnostics}`));
    });
  });
}

function post(url: string, body: unknown, testId?: string, onData?: () => void) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(testId !== undefined && { "X-Test-Id": testId }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(chunk);
          onData?.();
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

const chat = (text = "question", stream = false) => ({
  model: "gpt-4o",
  messages: [{ role: "user", content: text }],
  stream,
});
const send = (mock: LLMock, text = "question", id?: string) =>
  post(`${mock.url}/v1/chat/completions`, chat(text), id);
const contents = (mock: LLMock) => mock.getFixtures().map((f) => f.response);
const reload = (path: string) => new LLMock().loadFixtureDir(path);

async function start(
  record?: RecordConfig,
  options: Pick<MockServerOptions, "requestTransform"> = {},
) {
  const mock = new LLMock({ port: 0, record, ...options });
  mocks.push(mock);
  await mock.start();
  return mock;
}

async function setup(options: Partial<RecordConfig> = {}, path = directory()) {
  const upstream = await start();
  upstream.on({ userMessage: /./ }, { content: "recorded answer" });
  const providers = Object.fromEntries(
    [
      "openai",
      "openrouter",
      "anthropic",
      "gemini",
      "bedrock",
      "cohere",
      "ollama",
      "azure",
      "vertexai",
    ].map((key) => [key, upstream.url]),
  );
  const record = { providers, fixturePath: path, ...options };
  const mock = await start(record);
  return { mock, upstream, path, record };
}

async function controlled(options: Pick<MockServerOptions, "requestTransform"> = {}) {
  const arrivals: Array<ReturnType<typeof deferred<http.ServerResponse>>> = [];
  let index = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    const slot = index++;
    arrivals[slot] ??= deferred<http.ServerResponse>();
    arrivals[slot].resolve(res);
    releases.push(() => {
      if (!res.writableEnded) reply(res, "cleanup");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const path = directory();
  const record = {
    providers: { openai: `http://127.0.0.1:${(server.address() as { port: number }).port}` },
    fixturePath: path,
    proxyOnly: false,
  };
  const mock = await start(record, options);
  const arrived = (slot: number) => {
    arrivals[slot] ??= deferred<http.ServerResponse>();
    return arrivals[slot].promise;
  };
  return { mock, path, record, arrived };
}

function reply(res: http.ServerResponse, content: string) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    }),
  );
}

describe("private recording sessions", () => {
  it.each(["", " \t ", DEFAULT_TEST_ID])(
    "rejects invalid ID %j without reserving a session",
    async (id) => {
      const { mock } = await setup();
      mock.beginRecordingSession("probe").discard();
      expect(() => mock.beginRecordingSession(id)).toThrow();
      expect(await mock.beginRecordingSession("valid").commit()).toBe(0);
    },
  );

  it("requires a running, recording, non-proxy-only server", async () => {
    const { mock, record } = await setup();
    const session: RecordingSession = mock.beginRecordingSession("type-check");
    session.discard();
    await mock.stop();
    expect(() => mock.beginRecordingSession("stopped")).toThrow();
    await mock.start();
    mock.disableRecording();
    expect(() => mock.beginRecordingSession("disabled")).toThrow();
    mock.enableRecording({ ...record, proxyOnly: true });
    expect(() => mock.beginRecordingSession("proxy-only")).toThrow();
    mock.enableRecording(record);
    expect(await mock.beginRecordingSession("valid").commit()).toBe(0);
  });

  it("reserves exact IDs, not filesystem-normalized names", async () => {
    const { mock } = await setup();
    const a = mock.beginRecordingSession("Case ID");
    expect(() => mock.beginRecordingSession("Case ID")).toThrow();
    const b = mock.beginRecordingSession("case id");
    const c = mock.beginRecordingSession("!!!");
    await send(mock, "upper", "Case ID");
    await send(mock, "lower", "case id");
    await send(mock, "punctuation", "!!!");
    b.discard();
    expect(await a.commit()).toBe(1);
    expect(await c.commit()).toBe(1);
    expect(mock.getFixtures().map((f) => f.match.userMessage)).toEqual(["upper", "punctuation"]);
  });

  it("keeps captures private to both memory and reload, including same-ID requests", async () => {
    const { mock, path } = await setup();
    const session = mock.beginRecordingSession("private");
    expect((await send(mock, "question", "private")).status).toBe(200);
    expect(mock.getFixtures()).toEqual([]);
    expect(reload(path).getFixtures()).toEqual([]);
    expect((await send(mock, "question", "private")).status).toBe(200);
    expect(await session.commit()).toBe(2);
    expect(contents(mock)).toEqual(
      Array(2).fill({
        content: "recorded answer",
        usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
      }),
    );
    expect(contents(reload(path))).toEqual(contents(mock));
    const replacement = mock.beginRecordingSession("private");
    await send(mock, "fresh", "private");
    expect(await session.commit()).toBe(2);
    expect(() => mock.beginRecordingSession("private")).toThrow();
    expect(await replacement.commit()).toBe(1);
    expect(
      reload(path)
        .getFixtures()
        .map((f) => f.match.userMessage)
        .sort(),
    ).toEqual(["fresh", "question", "question"]);
  });

  it("preserves existing fixture hits and counts only new captures", async () => {
    const { mock, path } = await setup();
    const session = mock.beginRecordingSession("hits");
    mock.on({ userMessage: "cached" }, { content: "local" });
    expect((await send(mock, "cached", "hits")).body).toContain("local");
    expect(await session.commit()).toBe(0);
    expect(contents(mock)).toEqual([{ content: "local" }]);
    expect(reload(path).getFixtures()).toEqual([]);
  });

  it("leaves unscoped recording immediate and preserves it at publication", async () => {
    const { mock, path } = await setup();
    const session = mock.beginRecordingSession("scoped");
    await send(mock, "scoped prompt", "scoped");
    await send(mock, "legacy prompt");
    expect(mock.getFixtures().map((f) => f.match.userMessage)).toEqual(["legacy prompt"]);
    expect(reload(path).getFixtures()).toHaveLength(1);
    expect(await session.commit()).toBe(1);
    expect(mock.getFixtures().map((f) => f.match.userMessage)).toEqual([
      "legacy prompt",
      "scoped prompt",
    ]);
    expect(
      reload(path)
        .getFixtures()
        .map((f) => f.match.userMessage)
        .sort(),
    ).toEqual(["legacy prompt", "scoped prompt"]);
  });

  it("uses the header before the query ID and accepts query-only IDs", async () => {
    const { mock } = await setup();
    const header = mock.beginRecordingSession("header");
    const query = mock.beginRecordingSession("query");
    await post(`${mock.url}/v1/chat/completions?testId=query`, chat("both"), "header");
    await post(`${mock.url}/v1/chat/completions?testId=query`, chat("query only"));
    expect(await header.commit()).toBe(1);
    expect(mock.getFixtures().map((f) => f.match.userMessage)).toEqual(["both"]);
    expect(await query.commit()).toBe(1);
    expect(mock.getFixtures().map((f) => f.match.userMessage)).toEqual(["both", "query only"]);
  });

  it("publishes in admission order, retains duplicates, and commits exactly once", async () => {
    const { mock, path, arrived } = await controlled();
    const session = mock.beginRecordingSession("order");
    const first = send(mock, "same", "order");
    const firstResponse = await arrived(0);
    const second = send(mock, "same", "order");
    const secondResponse = await arrived(1);
    const commit = session.commit();
    const duplicate = session.commit();
    reply(secondResponse, "second");
    await second;
    expect(mock.getFixtures()).toEqual([]);
    expect(reload(path).getFixtures()).toEqual([]);
    expect((await send(mock, "miss", "order")).status).toBe(409);
    mock.on({ userMessage: "hit" }, { content: "hit" });
    expect((await send(mock, "hit", "order")).status).toBe(200);
    reply(firstResponse, "first");
    await first;
    expect(await Promise.all([commit, duplicate])).toEqual([2, 2]);
    expect(await session.commit()).toBe(2);
    expect(contents(mock)).toEqual([
      { content: "hit" },
      { content: "first" },
      { content: "second" },
    ]);
    expect(contents(reload(path))).toEqual([{ content: "first" }, { content: "second" }]);
    expect(() => session.discard()).toThrow();
    expect(await mock.beginRecordingSession("order").commit()).toBe(0);
  });

  it("repairs failed publication without exposing or duplicating the batch", async () => {
    const parent = directory();
    const blocked = join(parent, "store");
    writeFileSync(blocked, "not a directory");
    const { mock } = await setup({}, blocked);
    const session = mock.beginRecordingSession("retry");
    await send(mock, "first", "retry");
    await send(mock, "second", "retry");
    await expect(session.commit()).rejects.toThrow();
    expect(mock.getFixtures()).toEqual([]);
    expect((await send(mock, "sealed", "retry")).status).toBe(409);
    expect(() => mock.beginRecordingSession("retry")).toThrow();
    unlinkSync(blocked);
    mkdirSync(blocked);
    expect(await session.commit()).toBe(2);
    expect(await session.commit()).toBe(2);
    expect(
      reload(blocked)
        .getFixtures()
        .map((f) => f.match.userMessage),
    ).toEqual(["first", "second"]);
    expect(mock.getFixtures()).toHaveLength(2);
  });

  it("empty commits do not require writable storage", async () => {
    const path = join(directory(), "file");
    writeFileSync(path, "untouched");
    const { mock } = await setup({}, path);
    const session = mock.beginRecordingSession("empty");
    expect(await session.commit()).toBe(0);
    expect(await session.commit()).toBe(0);
    expect(mock.getFixtures()).toEqual([]);
  });

  it("discards a drained private batch without affecting other sessions", async () => {
    const { mock, path } = await setup();
    const a = mock.beginRecordingSession("a");
    const b = mock.beginRecordingSession("b");
    await send(mock, "discarded", "a");
    await send(mock, "retained", "b");
    a.discard();
    a.discard();
    await expect(a.commit()).rejects.toThrow();
    expect(await b.commit()).toBe(1);
    expect(
      reload(path)
        .getFixtures()
        .map((f) => f.match.userMessage),
    ).toEqual(["retained"]);
  });

  it("discard during commit rejects it, fences late responses, and allows ID reuse", async () => {
    const { mock, path, arrived } = await controlled();
    const old = mock.beginRecordingSession("epoch");
    const request = send(mock, "old", "epoch");
    const response = await arrived(0);
    const outcome = old.commit().then(
      () => "published",
      () => "discarded",
    );
    old.discard();
    const replacement = mock.beginRecordingSession("epoch");
    old.discard();
    expect(() => mock.beginRecordingSession("epoch")).toThrow();
    const next = send(mock, "new", "epoch");
    reply(await arrived(1), "replacement");
    await next;
    reply(response, "old response still relayed");
    expect((await request).body).toContain("old response still relayed");
    expect(await outcome).toBe("discarded");
    expect(mock.getFixtures()).toEqual([]);
    expect(await replacement.commit()).toBe(1);
    expect(contents(reload(path))).toEqual([{ content: "replacement" }]);
    await expect(old.commit()).rejects.toThrow();
  });

  it("keeps sessions isolated across servers publishing to one directory", async () => {
    const path = directory();
    const a = await setup({}, path);
    const b = await setup({}, path);
    const sa = a.mock.beginRecordingSession("shared");
    const sb = b.mock.beginRecordingSession("shared");
    await send(a.mock, "from a", "shared");
    await send(b.mock, "from b", "shared");
    expect(await Promise.all([sa.commit(), sb.commit()])).toEqual([1, 1]);
    expect(a.mock.getFixtures().map((f) => f.match.userMessage)).toEqual(["from a"]);
    expect(b.mock.getFixtures().map((f) => f.match.userMessage)).toEqual(["from b"]);
    expect(
      reload(path)
        .getFixtures()
        .map((f) => f.match.userMessage)
        .sort(),
    ).toEqual(["from a", "from b"]);
  });

  it.each(["reset", "http reset", "reset alias", "stop", "enable", "disable"])(
    "%s fences unfinished operations",
    async (operation) => {
      const { mock, path, record, arrived } = await controlled();
      const session = mock.beginRecordingSession("lifecycle");
      const pending = send(mock, "late", "lifecycle");
      const response = await arrived(0);
      let stopping: Promise<void> | undefined;
      if (operation === "reset") mock.reset();
      else if (operation === "http reset")
        expect((await post(`${mock.url}/__aimock/reset`, {})).status).toBe(200);
      else if (operation === "reset alias")
        expect((await post(`${mock.url}/__aimock/reset/fixtures`, {})).status).toBe(200);
      else if (operation === "stop") stopping = mock.stop();
      else if (operation === "enable") mock.enableRecording(record);
      else mock.disableRecording();
      const outcome = session.commit().then(
        () => "published",
        () => "discarded",
      );
      reply(response, "late");
      expect((await pending).status).toBe(200);
      if (stopping) {
        await stopping;
        await mock.start();
      }
      expect(await outcome).toBe("discarded");
      expect(mock.getFixtures()).toEqual([]);
      expect(reload(path).getFixtures()).toEqual([]);
      mock.enableRecording(record);
      expect(await mock.beginRecordingSession("lifecycle").commit()).toBe(0);
    },
  );

  it("clearRequests leaves staged captures and the session alive", async () => {
    const { mock } = await setup();
    const session = mock.beginRecordingSession("journal");
    await send(mock, "staged", "journal");
    mock.clearRequests();
    expect(() => mock.beginRecordingSession("journal")).toThrow();
    expect(await session.commit()).toBe(1);
    expect(mock.getFixtures()).toHaveLength(1);
  });

  it("responses skipped by ordinary recorder do not count", async () => {
    const { mock, path } = await setup({ maxProxyBufferBytes: 1 });
    const session = mock.beginRecordingSession("skip");
    const response = await send(mock, "oversized", "skip");
    expect(response.status).toBe(200);
    expect(response.body).toContain("recorded answer");
    expect(await session.commit()).toBe(0);
    expect(mock.getFixtures()).toEqual([]);
    expect(reload(path).getFixtures()).toEqual([]);
  });

  it("live proxyOnly skips captures in an existing session without blocking relay or ID reuse", async () => {
    const { mock, path, record, arrived } = await controlled();
    const session = mock.beginRecordingSession("live-skip");
    record.proxyOnly = true;
    const skipped = send(mock, "do not capture", "live-skip");
    reply(await arrived(0), "still proxied");
    expect((await skipped).body).toContain("still proxied");
    expect(await session.commit()).toBe(0);
    expect(await session.commit()).toBe(0);
    expect(mock.getFixtures()).toEqual([]);
    expect(reload(path).getFixtures()).toEqual([]);

    record.proxyOnly = false;
    const replacement = mock.beginRecordingSession("live-skip");
    const kept = send(mock, "capture after repair", "live-skip");
    reply(await arrived(1), "recorded after repair");
    expect((await kept).status).toBe(200);
    expect(await replacement.commit()).toBe(1);
    expect(contents(mock)).toEqual([{ content: "recorded after repair" }]);
    expect(contents(reload(path))).toEqual(contents(mock));
  });

  it("a post-upstream transform exception cannot strand an admitted session operation", async () => {
    let failTransform = false;
    let transformThrew = false;
    const { mock, path, arrived } = await controlled({
      requestTransform: (request) => {
        if (failTransform) {
          transformThrew = true;
          throw new Error("Request normalization unavailable");
        }
        return request;
      },
    });
    const session = mock.beginRecordingSession("throwing-transform");
    const pending = send(mock, "failed capture", "throwing-transform");
    const upstream = await arrived(0);
    const commit = session.commit();
    failTransform = true;
    reply(upstream, "not recorded");
    const response = await pending;
    // A recorder may reuse its already-normalized request instead of calling
    // the transform again. Only an exception that actually occurs must drain.
    expect(response.status).toBe(transformThrew ? 500 : 200);
    expect(await commit).toBe(transformThrew ? 0 : 1);
    const prior = transformThrew ? [] : [{ content: "not recorded" }];
    expect(contents(mock)).toEqual(prior);
    expect(contents(reload(path))).toEqual(prior);

    failTransform = false;
    const replacement = mock.beginRecordingSession("throwing-transform");
    const repaired = send(mock, "healthy capture", "throwing-transform");
    reply(await arrived(1), "recorded after repair");
    expect((await repaired).status).toBe(200);
    expect(await replacement.commit()).toBe(1);
    expect(contents(mock)).toEqual([...prior, { content: "recorded after repair" }]);
    expect(contents(reload(path))).toHaveLength(prior.length + 1);
    expect(contents(reload(path))).toEqual(expect.arrayContaining(contents(mock)));
  });
});

describe("recording session composition", () => {
  it.each(["write", "publish"])(
    "a %s I/O failure does not publish and can be repaired",
    async (phase) => {
      const { mock, path } = await setup();
      const session = mock.beginRecordingSession("late-storage-error");
      await send(mock, "first", "late-storage-error");
      await send(mock, "second", "late-storage-error");
      let injected = false;
      const failStorage = (destination: unknown) => {
        const target =
          typeof destination === "string"
            ? destination
            : Buffer.isBuffer(destination)
              ? destination.toString()
              : destination instanceof URL
                ? fileURLToPath(destination)
                : undefined;
        if (target === undefined) return;
        const within = relative(path, resolve(target));
        if (isAbsolute(within) || within === ".." || within.startsWith(".." + sep)) return;
        injected = true;
        throw Object.assign(new Error("Injected storage I/O failure"), { code: "EIO" });
      };
      if (phase === "write") storageObserver.beforeWrite = failStorage;
      else storageObserver.beforeRename = (_source, destination) => failStorage(destination);
      let outcome: { published: boolean; count: number };
      try {
        outcome = await session.commit().then(
          (count) => ({ published: true, count }),
          () => ({ published: false, count: 0 }),
        );
      } finally {
        storageObserver.beforeRename = undefined;
        storageObserver.beforeWrite = undefined;
      }
      if (injected) {
        expect(outcome).toEqual({ published: false, count: 0 });
        expect(mock.getFixtures()).toEqual([]);
        expect(reload(path).getFixtures()).toEqual([]);
        expect(() => mock.beginRecordingSession("late-storage-error")).toThrow();
        expect((await send(mock, "sealed", "late-storage-error")).status).toBe(409);
        expect(await session.commit()).toBe(2);
      } else {
        expect(outcome).toEqual({ published: true, count: 2 });
      }
      expect(await session.commit()).toBe(2);
      expect(
        reload(path)
          .getFixtures()
          .map((f) => f.match.userMessage),
      ).toEqual(["first", "second"]);
      expect(contents(mock)).toEqual(contents(reload(path)));
    },
  );

  it("a drained commit and discard have one consistent publication outcome", async () => {
    const { mock, path } = await setup();
    const session = mock.beginRecordingSession("publication-race");
    await send(mock, "old", "publication-race");
    const result = session.commit().then(
      (count) => ({ published: true, count }),
      () => ({ published: false, count: 0 }),
    );
    let discarded = false;
    try {
      session.discard();
      discarded = true;
    } catch {
      // Publication may have completed synchronously before discard was called.
    }
    if (discarded) {
      const replacement = mock.beginRecordingSession("publication-race");
      expect(await result).toEqual({ published: false, count: 0 });
      expect(mock.getFixtures()).toEqual([]);
      expect(reload(path).getFixtures()).toEqual([]);
      expect(() => mock.beginRecordingSession("publication-race")).toThrow();
      await send(mock, "replacement", "publication-race");
      expect(await replacement.commit()).toBe(1);
      expect(
        reload(path)
          .getFixtures()
          .map((f) => f.match.userMessage),
      ).toEqual(["replacement"]);
    } else {
      expect(await result).toEqual({ published: true, count: 1 });
      expect(
        reload(path)
          .getFixtures()
          .map((f) => f.match.userMessage),
      ).toEqual(["old"]);
      expect(contents(mock)).toEqual(contents(reload(path)));
    }
  });

  it.each(["reset", "http reset", "reset alias", "stop", "enable", "disable"])(
    "%s also fences a sealed session with commit already pending",
    async (operation) => {
      const { mock, path, record, arrived } = await controlled();
      const session = mock.beginRecordingSession("sealed-lifecycle");
      const pending = send(mock, "late", "sealed-lifecycle");
      const response = await arrived(0);
      const outcome = session.commit().then(
        () => "published",
        () => "discarded",
      );
      let stopping: Promise<void> | undefined;
      if (operation === "reset") mock.reset();
      else if (operation === "http reset")
        expect((await post(`${mock.url}/__aimock/reset`, {})).status).toBe(200);
      else if (operation === "reset alias")
        expect((await post(`${mock.url}/__aimock/reset/fixtures`, {})).status).toBe(200);
      else if (operation === "stop") stopping = mock.stop();
      else if (operation === "enable") mock.enableRecording(record);
      else mock.disableRecording();
      reply(response, "still relayed");
      expect((await pending).status).toBe(200);
      if (stopping) {
        await stopping;
        await mock.start();
      }
      expect(await outcome).toBe("discarded");
      expect(mock.getFixtures()).toEqual([]);
      expect(reload(path).getFixtures()).toEqual([]);
      mock.enableRecording(record);
      expect(await mock.beginRecordingSession("sealed-lifecycle").commit()).toBe(0);
    },
  );

  it("independent processes both retain their publications in one directory", async () => {
    const { mock, upstream, path } = await setup();
    const previous = mock.beginRecordingSession("shared");
    await send(mock, "already committed", "shared");
    expect(await previous.commit()).toBe(1);
    const release = deferred<void>();
    let writersReady = 0;
    const barrier = {
      arrived: () => {
        if (++writersReady === 2) release.resolve();
      },
      released: release.promise,
    };
    expect(
      await Promise.all([
        processWriter(path, upstream.url, "from process a", barrier),
        processWriter(path, upstream.url, "from process b", barrier),
      ]),
    ).toEqual([1, 1]);
    expect(
      reload(path)
        .getFixtures()
        .map((f) => f.match.userMessage)
        .sort(),
    ).toEqual(["already committed", "from process a", "from process b"]);
  }, 60000);

  it("directory readers see whole published batches at storage mutation boundaries", async () => {
    const { mock, path } = await setup();
    const first = mock.beginRecordingSession("earlier-batch");
    await send(mock, "previous", "earlier-batch");
    expect(await first.commit()).toBe(1);
    const session = mock.beginRecordingSession("atomic-batch");
    await send(mock, "alpha", "atomic-batch");
    expect(
      (await post(`${mock.url}/api/chat`, { ...chat("beta"), model: "llama3" }, "atomic-batch"))
        .status,
    ).toBe(200);
    const snapshots: unknown[] = [];
    storageObserver.afterMutation = () => {
      snapshots.push(
        reload(path)
          .getFixtures()
          .map((f) => f.match.userMessage)
          .sort(),
      );
    };
    try {
      storageObserver.afterMutation();
      expect(await session.commit()).toBe(2);
      storageObserver.afterMutation();
    } finally {
      storageObserver.afterMutation = undefined;
    }
    for (const snapshot of snapshots) {
      expect([["previous"], ["alpha", "beta", "previous"]]).toContainEqual(snapshot);
    }
    expect(
      reload(path)
        .getFixtures()
        .map((f) => f.match.userMessage)
        .sort(),
    ).toEqual(["alpha", "beta", "previous"]);
  });

  it("a late data-write failure exposes no captures and remains retryable", async () => {
    const { mock, path } = await setup();
    const earlier = mock.beginRecordingSession("earlier");
    await send(mock, "previous", "earlier");
    expect(await earlier.commit()).toBe(1);
    const batch = mock.beginRecordingSession("late-io-error");
    await send(mock, "alpha", "late-io-error");
    await send(mock, "beta", "late-io-error");
    const observed: unknown[] = [];
    storageObserver.afterDataWrite = () => {
      // Simulate an I/O failure reported after data transfer, before the
      // write operation returns (for example, failure while closing a file).
      storageObserver.afterDataWrite = undefined;
      observed.push(
        reload(path)
          .getFixtures()
          .map((f) => f.match.userMessage)
          .sort(),
      );
      throw Object.assign(new Error("Injected data-write failure"), { code: "EIO" });
    };
    try {
      await expect(batch.commit()).rejects.toThrow();
    } finally {
      storageObserver.afterDataWrite = undefined;
    }
    expect(observed).toEqual([["previous"]]);
    for (const reader of [mock, reload(path)]) {
      expect(reader.getFixtures().map((f) => f.match.userMessage)).toEqual(["previous"]);
    }
    expect((await send(mock, "sealed miss", "late-io-error")).status).toBe(409);
    expect(await batch.commit()).toBe(2);
    expect(await batch.commit()).toBe(2);
    for (const reader of [mock, reload(path)]) {
      expect(
        reader
          .getFixtures()
          .map((f) => f.match.userMessage)
          .sort(),
      ).toEqual(["alpha", "beta", "previous"]);
    }
  });

  it("counts a saved capture without an actionable replay match without caching it", async () => {
    const { mock, arrived, path } = await controlled();
    const session = mock.beginRecordingSession("empty-match");
    const pending = post(
      `${mock.url}/v1/chat/completions`,
      { model: "gpt-4o", messages: [] },
      "empty-match",
    );
    reply(await arrived(0), "no prompt");
    expect((await pending).status).toBe(200);
    expect(await session.commit()).toBe(1);
    expect(mock.getFixtures()).toEqual([]);
    expect(contents(reload(path))).toEqual([{ content: "no prompt" }]);
  });

  it("commit waits for the complete admitted stream, not its first relayed delta", async () => {
    const { mock, arrived, path } = await controlled();
    const session = mock.beginRecordingSession("stream-drain");
    const received = deferred<void>();
    const pending = post(
      mock.url + "/v1/chat/completions",
      chat("stream", true),
      "stream-drain",
      () => received.resolve(),
    );
    const response = await arrived(0);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"index":0,"delta":{"content":"first "}}]}\n\n');
    await received.promise;
    let settled = false;
    const commit = session.commit().finally(() => {
      settled = true;
    });
    try {
      mock.on({ userMessage: "hit" }, { content: "local" });
      expect((await send(mock, "hit", "stream-drain")).status).toBe(200);
      expect(settled).toBe(false);
      expect(contents(mock)).toEqual([{ content: "local" }]);
      expect(reload(path).getFixtures()).toEqual([]);
      expect((await send(mock, "miss", "stream-drain")).status).toBe(409);
    } finally {
      response.end(
        'data: {"choices":[{"index":0,"delta":{"content":"second"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
      await pending;
    }
    expect(await commit).toBe(1);
    expect(contents(reload(path))).toEqual([{ content: "first second" }]);
    expect(contents(mock)).toEqual([{ content: "local" }, { content: "first second" }]);
  });

  it("does not stage unrelated embedding recordings for the same ID", async () => {
    const { mock, upstream, path } = await setup();
    upstream.onEmbedding("vector", { embedding: [0.25, 0.5, 0.75] });
    const session = mock.beginRecordingSession("other-api");
    expect(
      (
        await post(
          `${mock.url}/v1/embeddings`,
          { model: "text-embedding-3-small", input: "vector" },
          "other-api",
        )
      ).status,
    ).toBe(200);
    expect(mock.getFixtures()).toHaveLength(1);
    expect(mock.getFixtures()[0].response).toMatchObject({ embedding: [0.25, 0.5, 0.75] });
    expect(contents(reload(path))).toEqual(contents(mock));
    expect(await session.commit()).toBe(0);
  });

  it.each(["open", "sealed"])(
    "records Fal models with generation-like names normally while its session is %s",
    async (state) => {
      const payload = { images: [{ url: "https://example.invalid/generated.png" }] };
      const admitted = deferred<http.ServerResponse>();
      let falCalls = 0;
      const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          if (req.url?.includes("/chat/completions")) {
            releases.push(() => {
              if (!res.writableEnded) reply(res, "chat answer");
            });
            admitted.resolve(res);
          } else {
            falCalls++;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(payload));
          }
        });
      });
      servers.push(upstream);
      await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
      const path = directory();
      const mock = await start({ fixturePath: path, providers: { openai: url, fal: url } });
      const session = mock.beginRecordingSession("other-api");
      let pending: ReturnType<typeof send> | undefined;
      let held: http.ServerResponse | undefined;
      let committing: Promise<number> | undefined;
      if (state === "sealed") {
        pending = send(mock, "hold", "other-api");
        held = await admitted.promise;
        committing = session.commit();
      }
      const requestFal = () =>
        fetch(`${mock.url}/fal/owner/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Test-Id": "other-api",
            "x-fal-target-host": "fal.run",
          },
          body: JSON.stringify({ prompt: "generate an image" }),
        });
      try {
        const response = await requestFal();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(payload);
        expect(falCalls).toBe(1);
        expect(contents(mock)).toHaveLength(1);
        expect(contents(mock)[0]).toMatchObject({ json: payload });
        expect(contents(reload(path))).toEqual(contents(mock));
        const replay = await requestFal();
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual(payload);
        expect(falCalls).toBe(1);
      } finally {
        if (held) reply(held, "chat answer");
        await pending;
        await committing;
      }
      expect(await session.commit()).toBe(state === "sealed" ? 1 : 0);
      const published = contents(mock);
      const persisted = contents(reload(path));
      expect(published).toHaveLength(state === "sealed" ? 2 : 1);
      expect(persisted).toHaveLength(published.length);
      expect(persisted).toEqual(expect.arrayContaining(published));
    },
  );

  it("exports the typed session contract from the package root", async () => {
    const { mock } = await setup();
    mock.beginRecordingSession("public-type").discard();
    const filename = fileURLToPath(new URL("./session-api_352415.ts", import.meta.url)).replace(
      /\\/g,
      "/",
    );
    const source = `import { LLMock, type RecordingSession } from "../index.js";
      const session: RecordingSession = new LLMock().beginRecordingSession("typed");
      const committed: Promise<number> = session.commit();
      const discarded: void = session.discard();`;
    const options = {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      types: ["node"],
    };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, language, onError, create) =>
      name === filename
        ? ts.createSourceFile(name, source, language, true)
        : original(name, language, onError, create);
    const program = ts.createProgram([filename], options, host);
    expect(program.getSourceFile(filename)).toBeDefined();
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => !d.file || d.file.fileName === filename);
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual(
      [],
    );
  }, 60000);

  it("does not retroactively admit an already-proxied request", async () => {
    const { mock, arrived, path } = await controlled();
    expect(await mock.beginRecordingSession("probe").commit()).toBe(0);
    const pending = send(mock, "earlier", "late-start");
    const response = await arrived(0);
    const session = mock.beginRecordingSession("late-start");
    expect(await session.commit()).toBe(0);
    reply(response, "ordinary recording");
    await pending;
    expect(contents(mock)).toEqual([{ content: "ordinary recording" }]);
    expect(contents(reload(path))).toEqual(contents(mock));
  });

  it("a failed commit can be discarded, then replaced", async () => {
    const path = join(directory(), "blocked");
    writeFileSync(path, "file");
    const { mock } = await setup({}, path);
    const old = mock.beginRecordingSession("repair");
    await send(mock, "dropped", "repair");
    await expect(old.commit()).rejects.toThrow();
    old.discard();
    unlinkSync(path);
    mkdirSync(path);
    const fresh = mock.beginRecordingSession("repair");
    await send(mock, "kept", "repair");
    expect(await fresh.commit()).toBe(1);
    expect(
      reload(path)
        .getFixtures()
        .map((f) => f.match.userMessage),
    ).toEqual(["kept"]);
    await expect(old.commit()).rejects.toThrow();
  });

  it("resetting one server does not discard another server's session", async () => {
    const a = await setup();
    const b = await setup();
    const sa = a.mock.beginRecordingSession("same");
    const sb = b.mock.beginRecordingSession("same");
    await send(a.mock, "discard", "same");
    await send(b.mock, "keep", "same");
    a.mock.reset();
    await expect(sa.commit()).rejects.toThrow();
    expect(await sb.commit()).toBe(1);
    expect(b.mock.getFixtures().map((f) => f.match.userMessage)).toEqual(["keep"]);
  });

  it("one commit includes different provider captures in request order", async () => {
    const { mock, path } = await setup();
    const session = mock.beginRecordingSession("mixed");
    await post(`${mock.url}/api/chat`, { ...chat("ollama", true), model: "llama3" }, "mixed");
    await send(mock, "openai", "mixed");
    await post(`${mock.url}/v1/messages`, { ...chat("anthropic"), max_tokens: 32 }, "mixed");
    expect(reload(path).getFixtures()).toEqual([]);
    expect(await session.commit()).toBe(3);
    expect(mock.getFixtures().map((f) => f.match.userMessage)).toEqual([
      "ollama",
      "openai",
      "anthropic",
    ]);
    expect(
      reload(path)
        .getFixtures()
        .map((f) => f.match.userMessage),
    ).toEqual(["ollama", "openai", "anthropic"]);
  });

  it("overlapping providers retain one admission order in memory and after reload", async () => {
    const { mock, path, record, arrived } = await controlled();
    mock.enableRecording({
      ...record,
      providers: { ...record.providers, ollama: record.providers.openai },
    });
    const session = mock.beginRecordingSession("overlapping");
    const first = send(mock, "first A", "overlapping");
    const firstResponse = await arrived(0);
    const middle = post(
      `${mock.url}/api/chat`,
      { ...chat("middle B"), model: "llama3" },
      "overlapping",
    );
    const middleResponse = await arrived(1);
    const last = send(mock, "last A", "overlapping");
    const lastResponse = await arrived(2);
    const committed = session.commit();
    middleResponse.writeHead(200, { "Content-Type": "application/json" });
    middleResponse.end(
      JSON.stringify({
        model: "llama3",
        message: { role: "assistant", content: "middle answer" },
        done: true,
      }),
    );
    expect((await middle).status).toBe(200);
    reply(lastResponse, "last answer");
    expect((await last).status).toBe(200);
    expect(mock.getFixtures()).toEqual([]);
    expect(reload(path).getFixtures()).toEqual([]);
    reply(firstResponse, "first answer");
    expect((await first).status).toBe(200);
    expect(await committed).toBe(3);
    for (const reader of [mock, reload(path)]) {
      expect(reader.getFixtures().map((fixture) => fixture.match.userMessage)).toEqual([
        "first A",
        "middle B",
        "last A",
      ]);
      expect(contents(reader)).toEqual([
        { content: "first answer" },
        { content: "middle answer" },
        { content: "last answer" },
      ]);
    }
  });

  it("rejects new sessions throughout shutdown and permits them after restart", async () => {
    const { mock, path, arrived } = await controlled();
    const existing = mock.beginRecordingSession("closing");
    const request = send(mock, "in flight", "closing");
    const response = await arrived(0);
    const stopping = mock.stop();
    try {
      expect(() => mock.beginRecordingSession("late")).toThrow();
    } finally {
      reply(response, "still relayed");
      expect((await request).status).toBe(200);
      await stopping;
    }
    await expect(existing.commit()).rejects.toThrow();
    expect(() => mock.beginRecordingSession("late")).toThrow();
    expect(reload(path).getFixtures()).toEqual([]);
    await mock.start();
    expect(await mock.beginRecordingSession("late").commit()).toBe(0);
  });

  it.each([false, true])(
    "retains tool calls and usage, not just display text (stream=%s)",
    async (stream) => {
      const { mock, upstream, path, record } = await setup();
      upstream.clearFixtures();
      upstream.on(
        { userMessage: "tools" },
        {
          content: "Calling two tools",
          toolCalls: [
            { id: "call_1", name: "lookup", arguments: '{"q":"first"}' },
            { id: "call_2", name: "lookup", arguments: '{"q":"second"}' },
          ],
          usage: { prompt_tokens: 17, completion_tokens: 31, total_tokens: 48 },
        },
      );
      const session = mock.beginRecordingSession("data");
      const body = {
        ...chat("tools", stream),
        messages: [{ role: "system", content: "Use the lookup tool." }, ...chat("tools").messages],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      };
      const ordinary = await start({ ...record, fixturePath: directory() });
      expect((await post(`${ordinary.url}/v1/chat/completions`, body)).status).toBe(200);
      const response = await post(`${mock.url}/v1/chat/completions`, body, "data");
      expect(response.status).toBe(200);
      expect(await session.commit()).toBe(1);
      const saved = mock.getFixtures()[0].response;
      expect(saved).toMatchObject({
        content: "Calling two tools",
        toolCalls: [
          { name: "lookup", arguments: '{"q":"first"}' },
          { name: "lookup", arguments: '{"q":"second"}' },
        ],
      });
      if (!stream)
        expect(saved).toMatchObject({
          usage: { prompt_tokens: 17, completion_tokens: 31, total_tokens: 48 },
        });
      expect(contents(reload(path))).toEqual(contents(mock));
      const fixture = mock.getFixtures()[0];
      expect(fixture.metadata).toMatchObject({
        systemHash: expect.any(String),
        toolsHash: expect.any(String),
      });
      expect(fixture.metadata).toEqual(ordinary.getFixtures()[0].metadata);
      if (stream) expect(fixture.recordedTimings).toBeDefined();
      expect(reload(path).getFixtures()).toEqual(mock.getFixtures());
    },
  );
});

const routes = [
  {
    name: "Chat Completions",
    path: () => "/v1/chat/completions",
    body: (s: boolean) => chat("question", s),
  },
  {
    name: "compatible prefix",
    path: () => "/custom/v4/chat/completions",
    body: (s: boolean) => chat("question", s),
  },
  {
    name: "Responses",
    path: () => "/v1/responses",
    body: (s: boolean) => ({ model: "gpt-4o", input: "question", stream: s }),
  },
  {
    name: "Messages",
    path: () => "/v1/messages",
    body: (s: boolean) => ({ ...chat("question", s), max_tokens: 128 }),
  },
  {
    name: "Gemini",
    path: (s: boolean) =>
      `/v1beta/models/gemini-2.5-flash:${s ? "streamGenerateContent" : "generateContent"}`,
    body: () => ({ contents: [{ role: "user", parts: [{ text: "question" }] }] }),
  },
  {
    name: "Interactions",
    path: () => "/v1beta/interactions",
    body: (s: boolean) => ({ model: "gemini-2.5-flash", input: "question", stream: s }),
  },
  {
    name: "Bedrock Invoke",
    path: (s: boolean) =>
      `/model/anthropic.claude-3-sonnet/${s ? "invoke-with-response-stream" : "invoke"}`,
    body: () => ({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 128,
      messages: [{ role: "user", content: "question" }],
    }),
  },
  {
    name: "Bedrock Converse",
    path: (s: boolean) => `/model/anthropic.claude-3-sonnet/${s ? "converse-stream" : "converse"}`,
    body: () => ({ messages: [{ role: "user", content: [{ text: "question" }] }] }),
  },
  {
    name: "Cohere",
    path: () => "/v2/chat",
    body: (s: boolean) => ({ ...chat("question", s), model: "command-r" }),
  },
  {
    name: "Ollama chat",
    path: () => "/api/chat",
    body: (s: boolean) => ({ ...chat("question", s), model: "llama3" }),
  },
  {
    name: "Ollama generate",
    path: () => "/api/generate",
    body: (s: boolean) => ({ model: "llama3", prompt: "question", stream: s }),
  },
];

it("a failed commit stays sealed on every generation route and streaming form", async () => {
  const path = join(directory(), "blocked");
  writeFileSync(path, "not a directory");
  const { mock } = await setup({}, path);
  const session = mock.beginRecordingSession("sealed-routes");
  await send(mock, "staged", "sealed-routes");
  await expect(session.commit()).rejects.toThrow();
  for (const route of routes) {
    for (const stream of [false, true]) {
      const response = await post(
        mock.url + route.path(stream),
        route.body(stream),
        "sealed-routes",
      );
      expect.soft(response.status, `${route.name}, stream=${stream}`).toBe(409);
    }
  }
  expect(mock.getFixtures()).toEqual([]);
  session.discard();
});

describe.each(routes)("$name session recording", (route) => {
  it.each([false, true])("preserves and reloads generation output (stream=%s)", async (stream) => {
    const { mock, path, record } = await setup();
    const session = mock.beginRecordingSession("provider");
    const ordinary = await start({ ...record, fixturePath: directory() });
    expect((await post(ordinary.url + route.path(stream), route.body(stream))).status).toBe(200);
    expect(ordinary.getFixtures()).toHaveLength(1);
    const response = await post(mock.url + route.path(stream), route.body(stream), "provider");
    expect(response.status).toBe(200);
    expect(mock.getFixtures()).toEqual([]);
    expect(reload(path).getFixtures()).toEqual([]);
    expect(await session.commit()).toBe(1);
    expect(mock.getFixtures()).toHaveLength(1);
    expect(contents(mock)).toEqual(contents(ordinary));
    expect(mock.getFixtures()[0].match).toEqual(ordinary.getFixtures()[0].match);
    const replay = reload(path);
    expect(contents(replay)).toEqual(contents(mock));
    mocks.push(replay);
    await replay.start();
    const replayed = await post(replay.url + route.path(false), route.body(false));
    const ordinaryReplay = await post(ordinary.url + route.path(false), route.body(false));
    expect(replayed.status).toBe(ordinaryReplay.status);
    // Compare the captured response, not generated transport IDs or timestamps.
    const captured = mock.getFixtures()[0].response;
    if ("content" in captured) {
      expect(replayed.body).toContain(captured.content);
    } else if ("error" in captured) {
      expect(JSON.parse(replayed.body).error).toEqual(JSON.parse(ordinaryReplay.body).error);
    }
  });
});
