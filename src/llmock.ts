import type {
  ChaosConfig,
  EmbeddingFixtureOpts,
  Fixture,
  FixtureFileEntry,
  FixtureMatch,
  FixtureOpts,
  FixtureResponse,
  MockServerOptions,
  Mountable,
  RecordConfig,
} from "./types.js";
import { createServer, type ServerInstance } from "./server.js";
import {
  loadFixtureFile,
  loadFixturesFromDir,
  entryToFixture,
  validateFixtures,
} from "./fixture-loader.js";
import { Journal } from "./journal.js";
import type { SearchFixture, SearchResult } from "./search.js";
import type { RerankFixture, RerankResult } from "./rerank.js";
import type { ModerationFixture, ModerationResult } from "./moderation.js";

export class LLMock {
  private fixtures: Fixture[] = [];
  private searchFixtures: SearchFixture[] = [];
  private rerankFixtures: RerankFixture[] = [];
  private moderationFixtures: ModerationFixture[] = [];
  private mounts: Array<{ path: string; handler: Mountable }> = [];
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

  /**
   * Add fixtures from a JSON string or pre-parsed array of fixture entries.
   * Validates all fixtures and throws if any have severity "error".
   */
  addFixturesFromJSON(input: string | FixtureFileEntry[]): this {
    const entries: FixtureFileEntry[] = typeof input === "string" ? JSON.parse(input) : input;
    const converted = entries.map(entryToFixture);
    const issues = validateFixtures(converted);
    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      throw new Error(`Fixture validation failed: ${JSON.stringify(errors)}`);
    }
    this.fixtures.push(...converted);
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

  // ---- Service mock convenience methods ----

  onSearch(pattern: string | RegExp, results: SearchResult[]): this {
    this.searchFixtures.push({ match: pattern, results });
    return this;
  }

  onRerank(pattern: string | RegExp, results: RerankResult[]): this {
    this.rerankFixtures.push({ match: pattern, results });
    return this;
  }

  onModerate(pattern: string | RegExp, result: ModerationResult): this {
    this.moderationFixtures.push({ match: pattern, result });
    return this;
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

  // ---- Mounts ----

  mount(path: string, handler: Mountable): this {
    this.mounts.push({ path, handler });

    // If server is already running, wire up journal, registry, and baseUrl immediately
    // so late mounts behave identically to pre-start mounts.
    if (this.serverInstance) {
      if (handler.setJournal) handler.setJournal(this.serverInstance.journal);
      if (handler.setBaseUrl) handler.setBaseUrl(this.serverInstance.url + path);
      const registry = this.serverInstance.defaults.registry;
      if (registry && handler.setRegistry) handler.setRegistry(registry);
    }

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

  // ---- Chaos ----

  setChaos(config: ChaosConfig): this {
    this.options.chaos = config;
    return this;
  }

  clearChaos(): this {
    delete this.options.chaos;
    return this;
  }

  // ---- Recording ----

  enableRecording(config: RecordConfig): this {
    this.options.record = config;
    return this;
  }

  disableRecording(): this {
    delete this.options.record;
    return this;
  }

  // ---- Reset ----

  reset(): this {
    this.clearFixtures();
    this.searchFixtures.length = 0;
    this.rerankFixtures.length = 0;
    this.moderationFixtures.length = 0;
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
    this.serverInstance = await createServer(this.fixtures, this.options, this.mounts, {
      search: this.searchFixtures,
      rerank: this.rerankFixtures,
      moderation: this.moderationFixtures,
    });
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
