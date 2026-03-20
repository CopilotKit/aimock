import type {
  EmbeddingFixtureOpts,
  Fixture,
  FixtureMatch,
  FixtureOpts,
  FixtureResponse,
  MockServerOptions,
} from "./types.js";
import { createServer, type ServerInstance } from "./server.js";
import { loadFixtureFile, loadFixturesFromDir } from "./fixture-loader.js";
import { Journal } from "./journal.js";

export class LLMock {
  private fixtures: Fixture[] = [];
  private serverInstance: ServerInstance | null = null;
  private options: MockServerOptions;

  constructor(options?: MockServerOptions) {
    this.options = options ?? {};
  }

  // ---- Fixture management ----

  addFixture(fixture: Fixture): this {
    this.fixtures.push(fixture);
    return this;
  }

  addFixtures(fixtures: Fixture[]): this {
    this.fixtures.push(...fixtures);
    return this;
  }

  prependFixture(fixture: Fixture): this {
    this.fixtures.unshift(fixture);
    return this;
  }

  getFixtures(): readonly Fixture[] {
    return this.fixtures;
  }

  loadFixtureFile(filePath: string): this {
    this.fixtures.push(...loadFixtureFile(filePath));
    return this;
  }

  loadFixtureDir(dirPath: string): this {
    this.fixtures.push(...loadFixturesFromDir(dirPath));
    return this;
  }

  // Uses length = 0 to preserve array reference identity — the running
  // server reads this same array on every request.
  clearFixtures(): this {
    this.fixtures.length = 0;
    return this;
  }

  // ---- Convenience ----

  on(match: FixtureMatch, response: FixtureResponse, opts?: FixtureOpts): this {
    return this.addFixture({
      match,
      response,
      ...opts,
    });
  }

  onMessage(pattern: string | RegExp, response: FixtureResponse, opts?: FixtureOpts): this {
    return this.on({ userMessage: pattern }, response, opts);
  }

  onEmbedding(
    pattern: string | RegExp,
    response: FixtureResponse,
    opts?: EmbeddingFixtureOpts,
  ): this {
    return this.on({ inputText: pattern }, response, opts);
  }

  onJsonOutput(pattern: string | RegExp, jsonContent: object | string, opts?: FixtureOpts): this {
    const content = typeof jsonContent === "string" ? jsonContent : JSON.stringify(jsonContent);
    return this.on({ userMessage: pattern, responseFormat: "json_object" }, { content }, opts);
  }

  onToolCall(name: string, response: FixtureResponse, opts?: FixtureOpts): this {
    return this.on({ toolName: name }, response, opts);
  }

  onToolResult(id: string, response: FixtureResponse, opts?: FixtureOpts): this {
    return this.on({ toolCallId: id }, response, opts);
  }

  /**
   * Queue a one-shot error that will be returned for the next matching
   * request, then automatically removed. Implemented as an internal fixture
   * with a `predicate` that always matches (so it fires first) and spliced
   * at the front of the fixture list.
   */
  nextRequestError(
    status: number,
    errorBody?: { message?: string; type?: string; code?: string },
  ): this {
    const errorResponse: FixtureResponse = {
      error: {
        message: errorBody?.message ?? "Injected error",
        type: errorBody?.type ?? "server_error",
        code: errorBody?.code,
      },
      status,
    };
    const fixture: Fixture = {
      match: { predicate: () => true },
      response: errorResponse,
    };
    // Insert at front so it matches before everything else
    this.fixtures.unshift(fixture);
    // Remove after first match — the journal records it so tests can assert
    const original = fixture.match.predicate!;
    fixture.match.predicate = (req) => {
      const result = original(req);
      if (result) {
        // Defer splice so it doesn't mutate the array while matchFixture iterates it
        queueMicrotask(() => {
          const idx = this.fixtures.indexOf(fixture);
          if (idx !== -1) this.fixtures.splice(idx, 1);
        });
      }
      return result;
    };
    return this;
  }

  // ---- Journal proxies ----

  getRequests(): import("./types.js").JournalEntry[] {
    return this.journal.getAll();
  }

  getLastRequest(): import("./types.js").JournalEntry | null {
    return this.journal.getLast();
  }

  clearRequests(): void {
    this.journal.clear();
  }

  resetMatchCounts(): this {
    if (this.serverInstance) {
      this.serverInstance.journal.clearMatchCounts();
    }
    return this;
  }

  // ---- Reset ----

  reset(): this {
    this.clearFixtures();
    if (this.serverInstance) {
      this.serverInstance.journal.clear();
    }
    return this;
  }

  // ---- Server lifecycle ----

  async start(): Promise<string> {
    if (this.serverInstance) {
      throw new Error("Server already started");
    }
    this.serverInstance = await createServer(this.fixtures, this.options);
    return this.serverInstance.url;
  }

  async stop(): Promise<void> {
    if (!this.serverInstance) {
      throw new Error("Server not started");
    }
    const { server } = this.serverInstance;
    await new Promise<void>((resolve, reject) => {
      server.close((err: Error | undefined) => (err ? reject(err) : resolve()));
    });
    this.serverInstance = null;
  }

  // ---- Accessors ----

  get journal(): Journal {
    if (!this.serverInstance) {
      throw new Error("Server not started");
    }
    return this.serverInstance.journal;
  }

  get url(): string {
    if (!this.serverInstance) {
      throw new Error("Server not started");
    }
    return this.serverInstance.url;
  }

  get baseUrl(): string {
    return this.url;
  }

  get port(): number {
    const parsed = new URL(this.url); // this.url throws if not started
    if (!parsed.port) {
      throw new Error(`Server URL has no explicit port: ${this.url}`);
    }
    return parseInt(parsed.port, 10);
  }

  // ---- Static factory ----

  static async create(options?: MockServerOptions): Promise<LLMock> {
    const instance = new LLMock(options);
    await instance.start();
    return instance;
  }
}
