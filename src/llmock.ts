import type { LiveTranscript } from "./live-types.js";
import { normalizeLiveFixture, normalizeLiveOptions } from "./live-fixture.js";
import { isLiveResponse } from "./helpers.js";
import type {
  AudioResponse,
  ChaosConfig,
  EmbeddingFixtureOpts,
  FalQueueOpts,
  Fixture,
  FixtureFileEntry,
  FixtureFileResponse,
  FixtureMatch,
  FixtureOpts,
  ImageResponse,
  McpFakeSource,
  MockServerOptions,
  MisbehaviorConfig,
  MisbehaviorFaultId,
  Mountable,
  RecordConfig,
  ResponseFactory,
  TranscriptionResponse,
  VideoResponse,
  VoiceDesignResponse,
} from "./types.js";
import {
  createServer,
  createServerWithResolvedAuth,
  performFullReset,
  type ServerInstance,
} from "./server.js";
import type { ResolvedInboundAuth } from "./api-key-auth.js";
import {
  isInjectableStatus,
  INJECTED_STATUS_RANGE,
  queueOneShotError,
  clearFixtureQueue,
  entryToFixture,
  normalizeResponse,
  validateFixtures,
  FixtureLoadError,
} from "./fixture-loader.js";
import {
  loadFixtureFileWithServices,
  loadFixturesFromDirWithServices,
  type FixturesWithServices,
} from "./fixture-loader-services.js";
import { ensureFakeMount, isAutoMount, planFileFakes } from "./mcp-fakes-mount.js";
import { build, msg, quote } from "./message-text.js";
import { DEFAULT_TEST_ID } from "./constants.js";
import { Journal } from "./journal.js";
import type { SearchFixture, SearchResult } from "./search.js";
import type { RerankFixture, RerankResult } from "./rerank.js";
import type { ModerationFixture, ModerationResult } from "./moderation.js";
import { imageResponseToFalJson, videoResponseToFalJson } from "./fal.js";
import { voiceDesignToJson } from "./elevenlabs-voice.js";

import {
  getFixtureMisbehaviorPosition,
  parseMisbehavior,
  resolveMisbehaviorSeed,
  setFixtureMisbehaviorPosition,
  validateFixtureMisbehavior,
} from "./misbehavior.js";

/** Count-map keys retain caller identity while fault registrations remain distinct. */
class FixtureCountMap extends Map<Fixture, number> {
  constructor(private readonly identity: (fixture: Fixture) => Fixture) {
    super();
  }

  override get(key: Fixture): number | undefined {
    return super.get(this.identity(key));
  }

  override has(key: Fixture): boolean {
    return super.has(this.identity(key));
  }

  override set(key: Fixture, value: number): this {
    return super.set(this.identity(key), value);
  }

  override delete(key: Fixture): boolean {
    return super.delete(this.identity(key));
  }
}

export class LLMock {
  private fixtures: Fixture[] = [];
  private fixtureAddition = 0;
  private readonly fixtureCountOrigins = new WeakMap<Fixture, Fixture>();
  private searchFixtures: SearchFixture[] = [];
  private rerankFixtures: RerankFixture[] = [];
  private moderationFixtures: ModerationFixture[] = [];
  private mounts: Array<{ path: string; handler: Mountable }> = [];
  /** `mcpFakes` blocks loaded before `start()`, handed to the server at start (W2). */
  private mcpFakeBuffer: McpFakeSource[] = [];
  /** MCPMocks the server or a load auto-mounted (W3, W6), for the L6 check. */
  private serverInstance: ServerInstance | null = null;
  private options: MockServerOptions;
  private readonly resolvedInboundAuth?: ResolvedInboundAuth;

  constructor(options?: MockServerOptions, resolvedInboundAuth?: ResolvedInboundAuth) {
    this.options = options ?? {};
    if (this.options.live !== undefined) normalizeLiveOptions(this.options.live);
    if (this.options.misbehavior !== undefined) this.setMisbehavior(this.options.misbehavior);
    this.resolvedInboundAuth = resolvedInboundAuth;
  }

  // ---- Fixture management ----

  private normalizeFixture(fixture: Fixture): Fixture {
    const countIdentity = this.fixtureCountOrigins.get(fixture) ?? fixture;
    const previousPosition = getFixtureMisbehaviorPosition(fixture);
    const isNewAddition = previousPosition === undefined || /^code#\d+$/.test(previousPosition);
    const position = isNewAddition ? `code#${this.fixtureAddition++}` : previousPosition;
    // Re-adding a code fixture creates a new source without changing the old entry.
    if (isNewAddition) fixture = { ...fixture };
    if (fixture.misbehavior !== undefined) {
      const parsed = parseMisbehavior(fixture.misbehavior);
      if (parsed.ok) fixture = { ...fixture, misbehavior: parsed.config };
      const issue = parsed.ok ? validateFixtureMisbehavior(fixture) : parsed.issue;
      if (issue) {
        throw new FixtureLoadError({ rule: issue.rule, file: position, detail: issue.message });
      }
    }

    if (
      isLiveResponse(fixture.response) ||
      (fixture.match.endpoint === "openai-live" && typeof fixture.response !== "function")
    ) {
      fixture = {
        ...fixture,
        match: { ...fixture.match },
        response: normalizeLiveFixture(fixture.response, this.options.live),
      };
    } else if (fixture !== countIdentity) {
      this.fixtureCountOrigins.set(fixture, countIdentity);
    }
    setFixtureMisbehaviorPosition(fixture, position);
    return fixture;
  }

  addFixture(fixture: Fixture): this {
    this.fixtures.push(this.normalizeFixture(fixture));
    return this;
  }

  addFixtures(fixtures: Fixture[]): this {
    this.fixtures.push(...fixtures.map((fixture) => this.normalizeFixture(fixture)));
    return this;
  }

  prependFixture(fixture: Fixture): this {
    this.fixtures.unshift(this.normalizeFixture(fixture));
    return this;
  }

  getFixtures(): readonly Fixture[] {
    return this.fixtures;
  }

  /**
   * Load a fixture file: its LLM fixtures and its `mcpFakes` blocks (F4).
   * Before `start()` the blocks are buffered and handed to the server at
   * start (W2); after it they go to the MCPMock serving each block's `mount`
   * path, auto-mounted when none does (W6). A block that cannot be honored
   * throws a `FixtureLoadError` and nothing from the file is added.
   */
  loadFixtureFile(filePath: string): this {
    return this.acceptLoaded(loadFixtureFileWithServices(filePath, undefined, this.options.live));
  }

  /** As {@link loadFixtureFile}, for every fixture file under `dirPath`. */
  loadFixtureDir(dirPath: string): this {
    return this.acceptLoaded(
      loadFixturesFromDirWithServices(dirPath, undefined, this.options.live),
    );
  }

  /**
   * Add a load's fakes (all or nothing), then its LLM fixtures. Before start
   * the fakes are checked as the start-time hand-off will check them, with
   * the blocks already buffered and the mounts added so far, so a file whose
   * fakes would be rejected adds nothing. A mount added after the load can
   * still make `start()` reject.
   */
  private acceptLoaded(loaded: FixturesWithServices): this {
    if (loaded.mcpFakes.length > 0) {
      if (this.serverInstance) {
        this.addFakesAfterStart(this.serverInstance, loaded.mcpFakes);
      } else {
        planFileFakes(
          this.mounts,
          [...this.mcpFakeBuffer, ...loaded.mcpFakes],
          new Set(loaded.mcpFakes),
        );
        this.mcpFakeBuffer.push(...loaded.mcpFakes);
      }
    }
    this.fixtures.push(...loaded.fixtures);
    return this;
  }

  /**
   * W6 for a load after start. Every group of blocks (by `mount` path) is
   * checked before any mount is touched: a path held by a mount that is not
   * an MCPMock is a mount conflict, and each group is first added to a
   * throwaway store. Groups for an existing MCPMock are then added to it (its
   * own add is all or nothing and finds collisions with its loaded ids);
   * groups for a free path are added last, to a new auto-mounted MCPMock,
   * wired as W4. The add warnings (L8) are logged at `warn`.
   */
  private addFakesAfterStart(server: ServerInstance, sources: McpFakeSource[]): void {
    const { onExisting, onNew } = planFileFakes(this.mounts, sources);

    const logger = server.defaults.logger;
    for (const { handler, group } of onExisting) {
      const result = handler.addMcpFakes?.(group, { kind: "file" });
      for (const warning of result?.warnings ?? []) logger.warn(warning.message);
    }
    const registry = server.defaults.registry;
    for (const { path, group } of onNew) {
      const target = ensureFakeMount(
        this.mounts,
        path,
        {
          journal: server.journal,
          ...(registry ? { registry } : {}),
          logger,
          replaySpeed: server.defaults.replaySpeed,
        },
        logger,
      );
      // The check above found no mount at this path, and nothing ran since.
      if ("conflict" in target) continue;
      const result = target.handler.addMcpFakes?.(group, { kind: "file" });
      for (const warning of result?.warnings ?? []) logger.warn(warning.message);
    }
  }

  /** R4, R5: unload the fakes of every mount and the pre-start buffer. */
  private unloadMcpFakes(): void {
    this.mcpFakeBuffer.length = 0;
    for (const { handler } of this.mounts) handler.clearMcpFakes?.();
  }

  /**
   * Add fixtures from a JSON string or pre-parsed array of fixture entries.
   * Validates all fixtures and throws if any have severity "error".
   */
  addFixturesFromJSON(input: string | FixtureFileEntry[]): this {
    let entries: FixtureFileEntry[];
    if (typeof input === "string") {
      try {
        entries = JSON.parse(input);
      } catch (err) {
        throw new Error(
          `addFixturesFromJSON: invalid JSON — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      entries = input;
    }
    if (!Array.isArray(entries)) {
      throw new TypeError(
        "addFixturesFromJSON: expected an array of fixture entries; use loadFixtureFile for a {fixtures:[...]} file",
      );
    }
    const converted = entries.map((entry) => {
      const position = `code#${this.fixtureAddition++}`;
      const fixture = entryToFixture(entry, undefined, this.options.live, {
        file: position,
        index: 0,
      });
      setFixtureMisbehaviorPosition(fixture, position);
      return fixture;
    });

    const issues = validateFixtures(converted, this.options.live);
    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      throw new Error(`Fixture validation failed: ${JSON.stringify(errors)}`);
    }
    this.fixtures.push(...converted);
    return this;
  }

  // Clears in place to preserve array reference identity — the running
  // server reads this same array on every request — and invalidates any
  // one-shot claim parked in flight so it cannot re-arm into the cleared queue.
  clearFixtures(): this {
    clearFixtureQueue(this.fixtures);
    this.serverInstance?.journal.clearMisbehaviorCounters();
    this.unloadMcpFakes();
    return this;
  }

  // ---- Convenience ----

  on(
    match: FixtureMatch,
    response: FixtureFileResponse | ResponseFactory,
    opts?: FixtureOpts,
  ): this {
    return this.addFixture({
      match,
      response:
        typeof response === "function" ? response : normalizeResponse(response, this.options.live),
      ...opts,
    });
  }

  onLive(
    match: Omit<FixtureMatch, "endpoint">,
    transcript: LiveTranscript,
    opts?: FixtureOpts,
  ): this {
    return this.on({ ...match, endpoint: "openai-live" }, { live: transcript }, opts);
  }

  onMessage(
    pattern: string | RegExp,
    response: FixtureFileResponse | ResponseFactory,
    opts?: FixtureOpts,
  ): this {
    return this.on({ userMessage: pattern }, response, opts);
  }

  onEmbedding(
    pattern: string | RegExp,
    response: FixtureFileResponse | ResponseFactory,
    opts?: EmbeddingFixtureOpts,
  ): this {
    return this.on({ inputText: pattern }, response, opts);
  }

  onJsonOutput(pattern: string | RegExp, jsonContent: object | string, opts?: FixtureOpts): this {
    const content = typeof jsonContent === "string" ? jsonContent : JSON.stringify(jsonContent);
    return this.on({ userMessage: pattern, responseFormat: "json_object" }, { content }, opts);
  }

  onToolCall(
    name: string,
    response: FixtureFileResponse | ResponseFactory,
    opts?: FixtureOpts,
  ): this {
    return this.on({ toolName: name }, response, opts);
  }

  onToolResult(
    id: string,
    response: FixtureFileResponse | ResponseFactory,
    opts?: FixtureOpts,
  ): this {
    return this.on({ toolCallId: id }, response, opts);
  }

  onTurn(
    turn: number,
    pattern: string | RegExp,
    response: FixtureFileResponse | ResponseFactory,
    opts?: FixtureOpts,
  ): this {
    return this.on({ userMessage: pattern, turnIndex: turn }, response, opts);
  }

  onImage(prompt: string | RegExp, response: ImageResponse): this {
    return this.addFixture({
      match: { userMessage: prompt, endpoint: "image" },
      response,
    });
  }

  onSpeech(input: string | RegExp, response: AudioResponse): this {
    return this.addFixture({
      match: { userMessage: input, endpoint: "speech" },
      response,
    });
  }

  onTranscription(response: TranscriptionResponse): this {
    return this.addFixture({
      match: { endpoint: "transcription" },
      response,
    });
  }

  onTranslation(response: TranscriptionResponse): this {
    return this.addFixture({
      match: { endpoint: "translation" },
      response,
    });
  }

  onVideo(prompt: string | RegExp, response: VideoResponse): this {
    return this.addFixture({
      match: { userMessage: prompt, endpoint: "video" },
      response,
    });
  }

  onAudio(input: string | RegExp, response: AudioResponse): this {
    return this.addFixture({ match: { userMessage: input }, response });
  }

  onSoundEffect(text: string | RegExp, response: AudioResponse): this {
    return this.addFixture({
      match: { userMessage: text, endpoint: "audio-gen" },
      response,
    });
  }

  onMusic(prompt: string | RegExp, response: AudioResponse): this {
    return this.addFixture({
      match: { userMessage: prompt, endpoint: "audio-gen" },
      response,
    });
  }

  onElevenLabsTTS(text: string | RegExp, response: AudioResponse): this {
    return this.addFixture({
      match: { userMessage: text, endpoint: "elevenlabs-tts" },
      response,
    });
  }

  onElevenLabsVoiceDesign(description: string | RegExp, response: VoiceDesignResponse): this {
    return this.addFixture({
      match: { userMessage: description, endpoint: "elevenlabs-voice-design" },
      response: voiceDesignToJson(response),
    });
  }

  onFalAudio(prompt: string | RegExp, response: AudioResponse, model?: string): this {
    return this.addFixture({
      match: { userMessage: prompt, endpoint: "fal-audio", ...(model ? { model } : {}) },
      response,
    });
  }

  // fal.queue.* is the dominant client API; onFalRun is a sync alias.
  //
  // `opts.billableUnits` rides through to the completed `queue-result`
  // response's `x-fal-billable-units` header (emitted alongside
  // `x-fal-request-id`), letting consumers like `@tanstack/ai-fal` surface a
  // billed-units value on replay. Omit it to preserve the header-less default.
  onFalQueue(modelOrPrompt: string | RegExp, response: unknown, opts?: FalQueueOpts): this {
    const { billableUnits, ...fixtureOpts } = opts ?? {};
    return this.addFixture({
      match: { model: modelOrPrompt, endpoint: "fal" },
      response: { json: response, ...(billableUnits != null ? { billableUnits } : {}) },
      ...fixtureOpts,
    });
  }

  onFalRun(modelOrPrompt: string | RegExp, response: unknown, opts?: FalQueueOpts): this {
    return this.onFalQueue(modelOrPrompt, response, opts);
  }

  /**
   * Register a fal.ai image fixture. Wraps an `ImageResponse` (the shape used
   * by `onImage` and OpenAI/Azure image fixtures) into fal's image envelope
   * before storing it as a `RawJSONResponse`. Defaults `width`/`height` to
   * 1024 when the fixture's `ImageItem` doesn't carry them.
   */
  onFalImage(modelOrPrompt: string | RegExp, response: ImageResponse, opts?: FalQueueOpts): this {
    return this.onFalQueue(modelOrPrompt, imageResponseToFalJson(response), opts);
  }

  /**
   * Register a fal.ai video fixture. Wraps a `VideoResponse` into fal's video
   * envelope (`{ video: { url, content_type, file_name, file_size }, seed }`)
   * before storing it as a `RawJSONResponse`.
   */
  onFalVideo(modelOrPrompt: string | RegExp, response: VideoResponse, opts?: FalQueueOpts): this {
    return this.onFalQueue(modelOrPrompt, videoResponseToFalJson(response), opts);
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
   * inserted at the front of the fixture list; see `queueOneShotError` for
   * the endpoint gate and the served-not-evaluated consumption rule.
   */
  nextRequestError(
    status: number,
    errorBody?: { message?: string; type?: string; code?: string },
  ): this {
    // Same gate as `POST /__aimock/error` and fixture validation — this is the
    // form the docs use, and an unchecked status reaches `res.writeHead` on
    // the next matched request: 99/1000 throw there (the injected error is
    // lost and the caller sees a generic 500), and 1xx hangs the request until
    // the client times out. Throwing HERE names the offending call instead.
    if (!isInjectableStatus(status)) {
      throw new RangeError(
        `nextRequestError: invalid status ${String(status)} — must be ${INJECTED_STATUS_RANGE}`,
      );
    }
    queueOneShotError(this.fixtures, status, errorBody);
    return this;
  }

  // ---- Mounts ----

  mount(path: string, handler: Mountable): this {
    // W4: an auto-mounted MCPMock at `path` takes its requests first (dispatch
    // takes the first match), so the new mount is shadowed; so is one at
    // `path` plus "/", whose root request the auto-mount answers as its own.
    // An auto-mount lets any other sub-path fall through: that is no shadow.
    const shadowedBy = this.serverInstance
      ? this.mounts.find(
          (m) => isAutoMount(m.handler) && (path === m.path || path === m.path + "/"),
        )
      : undefined;
    this.mounts.push({ path, handler });

    // If server is already running, wire up journal, registry, logger and baseUrl
    // immediately so late mounts behave identically to pre-start mounts.
    if (this.serverInstance) {
      if (handler.setJournal) handler.setJournal(this.serverInstance.journal);
      if (handler.setBaseUrl) handler.setBaseUrl(this.serverInstance.url + path);
      const registry = this.serverInstance.defaults.registry;
      if (registry && handler.setRegistry) handler.setRegistry(registry);
      const logger = this.serverInstance.defaults.logger;
      if (handler.setLogger) handler.setLogger(logger);
      handler.setReplaySpeed?.(this.serverInstance.defaults.replaySpeed);
      if (shadowedBy) {
        logger.warn(
          build(
            msg`MCP fakes: the mount at ${quote(path)} is shadowed by the MCP mock auto-mounted at ${quote(shadowedBy.path)}; its requests reach the auto-mount`,
          ),
        );
      }
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

  /**
   * Clear the request journal. Fixture match-counts (sequencing state) are
   * left intact — use `resetMatchCounts()` for those.
   */
  clearRequests(): void {
    this.journal.clearEntries();
  }

  /**
   * Reset fixture match counts, and the MCP fakes consumption state of every
   * mount (R6), for `testId` or for all test ids. Fakes stay loaded.
   */
  resetMatchCounts(testId?: string): this {
    if (this.serverInstance) {
      this.serverInstance.journal.clearMatchCounts(testId);
    }
    for (const { handler } of this.mounts) handler.resetScenarioState?.(testId);
    return this;
  }

  // ---- Chaos ----

  /**
   * Set the server-wide chaos baseline. Writes through to a RUNNING server as
   * well as the construction options: an untagged `POST /__aimock/chaos`
   * installs a baseline override that shadows `options.chaos`, and without this
   * the call would silently do nothing until the next `reset()`. Per-testId
   * overrides still win over the baseline.
   */
  setChaos(config: ChaosConfig): this {
    this.options.chaos = config;
    if (this.serverInstance) this.serverInstance.defaults.chaos = config;
    return this;
  }

  /**
   * Turn chaos off everywhere: the construction config, the runtime baseline,
   * and every per-testId override (assigning `undefined` is the full-clear
   * signal the `defaults.chaos` setter defines).
   */
  clearChaos(): this {
    delete this.options.chaos;
    if (this.serverInstance) this.serverInstance.defaults.chaos = undefined;
    return this;
  }

  // ---- Semantic misbehavior ----

  /** Replace construction/runtime baselines without changing named test overrides. */
  setMisbehavior(config: MisbehaviorConfig | MisbehaviorFaultId): this {
    const parsed = parseMisbehavior(config);
    if (!parsed.ok) throw new TypeError(`${parsed.issue.rule}: ${parsed.issue.message}`);
    this.options.misbehavior = parsed.config;
    const defaults = this.serverInstance?.defaults;
    if (defaults?.misbehavior) {
      defaults.misbehavior.baseline =
        parsed.config.seed === "random"
          ? { ...parsed.config, seed: resolveMisbehaviorSeed(parsed.config.seed, defaults.logger) }
          : parsed.config;
      if (defaults.misbehavior.byTestId.has(DEFAULT_TEST_ID)) {
        defaults.misbehavior.byTestId.set(DEFAULT_TEST_ID, defaults.misbehavior.baseline);
      }
    }
    return this;
  }

  /** Clear the baseline and all runtime overrides, before or after start. */
  clearMisbehavior(): this {
    delete this.options.misbehavior;
    const scope = this.serverInstance?.defaults.misbehavior;
    if (scope) {
      scope.baseline = undefined;
      scope.byTestId.clear();
    }
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

  /**
   * Full reset — the in-process equivalent of `POST /__aimock/reset`. Shares
   * one implementation with the control-API route so the two cannot drift.
   *
   * The one deliberate difference: search / rerank / moderation fixtures are
   * also cleared here. Those are registered through this class only — the
   * control API has no route that creates them, so the HTTP reset can neither
   * reach nor observe them.
   *
   * NOT ALL OF THIS IS PER-INSTANCE. `performFullReset` clears module-global
   * state as well: the Gemini interaction and event-id counters
   * (`resetInteractionCounter` / `resetEventIdCounter` in
   * `./gemini-interactions.js`), the fal.ai job/queue maps (`falJobs`,
   * `falQueueStates`), the fine-tuning job store (`clearFineTuningStore`),
   * and the ElevenLabs Voice Design store (`clearElevenLabsVoices`). With two
   * `LLMock` instances live in one process,
   * `a.reset()` rewinds the Gemini id sequence that `b` is mid-way through —
   * `b` then re-emits `aimock-int-0` / `evt_1`, ids it has already handed
   * out — and drops `b`'s in-flight fal jobs. Give each instance its own
   * process (or its own vitest worker) if that matters.
   *
   * The global stores are cleared even before `start()`, when there is no
   * server instance to reset.
   */
  reset(): this {
    this.searchFixtures.length = 0;
    this.rerankFixtures.length = 0;
    this.moderationFixtures.length = 0;
    // `ServerInstance` carries no mounts, so the fakes are unloaded here (R4).
    this.unloadMcpFakes();
    performFullReset(this.fixtures, this.serverInstance);
    return this;
  }

  // ---- Server lifecycle ----

  async start(): Promise<string> {
    if (this.serverInstance) {
      throw new Error("Server already started");
    }
    const serviceFixtures = {
      search: this.searchFixtures,
      rerank: this.rerankFixtures,
      moderation: this.moderationFixtures,
      mcpFakes: [...this.mcpFakeBuffer],
    };
    this.serverInstance = await (this.resolvedInboundAuth
      ? createServerWithResolvedAuth(
          this.fixtures,
          this.options,
          this.resolvedInboundAuth,
          this.mounts,
          serviceFixtures,
        )
      : createServer(this.fixtures, this.options, this.mounts, serviceFixtures));
    const countIdentity = (fixture: Fixture) => this.fixtureCountOrigins.get(fixture) ?? fixture;
    this.serverInstance.journal.configureFixtureCountIdentity(
      countIdentity,
      () => new FixtureCountMap(countIdentity),
    );
    // The server holds the buffered fakes now (W2). A start that rejects took
    // its hand-off back, so the buffer is kept for a retry.
    this.mcpFakeBuffer.length = 0;
    return this.serverInstance.url;
  }

  closeLiveSessions(testId?: string): this {
    this.serverInstance?.closeLiveSessions(testId);
    return this;
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

/** @internal Configuration startup preserves a policy resolved from the selected source. */
export function createLLMockWithResolvedAuth(
  options: MockServerOptions,
  resolvedAuth: ResolvedInboundAuth,
): LLMock {
  return new LLMock(options, resolvedAuth);
}
